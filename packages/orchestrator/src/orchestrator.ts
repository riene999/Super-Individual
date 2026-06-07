import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { createDoubaoClient } from "./llm/doubao.js";
import { createConduitRepo } from "./repo/conduit.js";
import { emit as storeEmit, truncateAfter, readEvents } from "./events/store.js";
import { persistMemory, readAllMemories } from "./memory/store.js";
import { extractEntities } from "./memory/extract.js";
import { recall } from "./memory/recall.js";
import { validateRecalledFiles } from "./memory/validate.js";
import { loadSkills } from "./skills/registry.js";
import { aspectScan, filterRecallForScan } from "./agents/aspect-scan.js";
import { buildQuestionsFromAspects } from "./agents/clarify.js";
import { clarifyAgent } from "./agents/clarify.js";
import { planAgent } from "./agents/plan.js";
import { locateAgent } from "./agents/locate.js";
import { codeAgent } from "./agents/code.js";
import { verifyAgent } from "./agents/verify.js";
import type { RunEvent, ClarifiedRequest, ChangeSet, Skill } from "./types.js";

const MAX_VERIFY_RETRIES = 2;

// ────────────────────────────────────────────────────────────
// 单例事件总线，API 层通过它订阅特定 runId 的事件
// ────────────────────────────────────────────────────────────
export const bus = new EventEmitter();
bus.setMaxListeners(100);

function emitAndBroadcast<T>(runId: string, type: RunEvent["type"], payload: T): RunEvent<T> {
  const event = storeEmit(runId, type, payload);
  bus.emit(`run:${runId}`, event);
  return event;
}

// ────────────────────────────────────────────────────────────
// 暂停/恢复 + 中断
// ────────────────────────────────────────────────────────────

type AnswerResolve = (answers: Record<string, string>) => void;

const pendingAnswers = new Map<string, AnswerResolve>();
// 记录每个 run 当前所处阶段，供 replay 使用
const runPhase = new Map<string, string>();

export function provideClarificationAnswers(runId: string, answers: Record<string, string>): boolean {
  const resolve = pendingAnswers.get(runId);
  if (!resolve) return false;
  pendingAnswers.delete(runId);
  resolve(answers);
  return true;
}

function waitForAnswers(runId: string): Promise<Record<string, string>> {
  return new Promise((resolve) => pendingAnswers.set(runId, resolve));
}

// ────────────────────────────────────────────────────────────
// PR 描述生成
// ────────────────────────────────────────────────────────────

async function buildPRDescription(runId: string, req: ClarifiedRequest, diff: string): Promise<string> {
  const llm = createDoubaoClient({ runId });
  const result = await llm.chat([
    {
      role: "system",
      content: "根据需求描述和 git diff，输出 PR 标题（第一行）和描述（Markdown），不超过 200 字。",
    },
    {
      role: "user",
      content: `需求：${req.summary}\n\n字段：${req.fieldName}\n\n规则：${req.businessRule}\n\ndiff（前100行）：\n${diff.split("\n").slice(0, 100).join("\n")}`,
    },
  ], undefined, { agent: "pr:description" });
  return result.text;
}

// ────────────────────────────────────────────────────────────
// 主编排流程
// ────────────────────────────────────────────────────────────

export async function startRun(rawText: string): Promise<string> {
  const runId = randomUUID();
  const llm = createDoubaoClient({ runId });
  const repo = createConduitRepo();

  // 异步跑，不阻塞调用方
  runPipeline(runId, rawText, llm, repo).catch((err) => {
    emitAndBroadcast(runId, "run.error", { message: String(err?.message ?? err) });
    runPhase.delete(runId);
  });

  return runId;
}

async function runPipeline(
  runId: string,
  rawText: string,
  llm: ReturnType<typeof createDoubaoClient>,
  repo: ReturnType<typeof createConduitRepo>
): Promise<void> {
  emitAndBroadcast(runId, "run.started", {
    rawText,
    recallDisabled: process.env.DISABLE_RECALL === "true",
  });
  runPhase.set(runId, "clarify");

  // ── 1. Clarify analyze（只解析语义，不生成问题）──────────
  const allSkills = await loadSkills();
  const aspectUnion = Array.from(new Set(allSkills.flatMap((s) => s.possibleAspects)));
  const analysis = await clarifyAgent.analyze(rawText, llm);

  // ── 1.5. Recall（基于 partial.summary，让 RecallCard 早于 ClarifyBox）──
  let locateAttempt = 1;
  let recallMatchesForScan: Parameters<typeof filterRecallForScan>[0] = [];
  const recallDisabled = process.env.DISABLE_RECALL === "true";
  if (recallDisabled) console.log(`[recall] DISABLE_RECALL=true，跳过召回（baseline 模式）`);
  if (!recallDisabled) try {
    const queryEntities = await extractEntities(llm, {
      runId,
      summary: analysis.req.summary,
      skillUsed: "",
    });
    const memories = readAllMemories();
    const matches = recall(queryEntities, memories, { topK: 3, minScore: 0.3 });

    if (matches.length > 0) {
      const top = matches[0];
      const matchesPayload = matches.map((m) => ({
        runId: m.memory.runId,
        score: m.score,
        matchedDimensions: m.matchedDimensions,
        summary: m.memory.summary,
        skillUsed: m.memory.skillUsed,
        outcome: m.memory.outcome,
        expectedFiles: m.memory.changedFiles,
        clarifications: m.memory.clarifications,
      }));
      emitAndBroadcast(runId, "recall.matched", { queryEntities, matches: matchesPayload });
      recallMatchesForScan = matchesPayload;

      const { valid, stale } = validateRecalledFiles(repo, top.memory.changedFiles);
      if (stale.length > 0) {
        emitAndBroadcast(runId, "recall.stale", {
          historicalRunId: top.memory.runId,
          stale, valid,
          message: `${stale.length} file(s) from historical run no longer exist (likely refactored). Falling back to no-recall locate.`,
        });
        locateAttempt = 2;
      }
    }
  } catch (err) {
    console.warn(`[recall] 召回阶段失败（不阻塞）：${(err as Error).message}`);
  }

  // ── 2. Plan（前置到 user wait 之前 — 用 partial req 选 skill）──────────
  runPhase.set(runId, "plan");
  const ctx = repo.getContext();
  const planResult = await planAgent.run(analysis.req, ctx, llm);
  emitAndBroadcast(runId, "plan.done", {
    plan: planResult.plan,
    skillName: planResult.skill.name,
    score: planResult.score,
    by: planResult.by,
    candidates: planResult.candidates,
    routerReason: planResult.routerReason,
  });
  const skill = planResult.skill;

  // ── 2.5. aspectScan（WS-4 按需追问的核心）──────────
  runPhase.set(runId, "aspect-scan");
  const scanResult = await aspectScan(llm, {
    runId,
    rawText,
    candidateAspects: aspectUnion,
    recalledHistory: filterRecallForScan(recallMatchesForScan),
  });

  // 加固 2 末尾：过滤到属于选中 skill 的 aspect（跨 skill 同名 aspect 由 skill 内的语义决定）
  const skillAspectSet = new Set(skill.possibleAspects);
  const scanForSkill = scanResult.items.filter((it) => skillAspectSet.has(it.aspect));
  emitAndBroadcast(runId, "aspect.scanned", {
    skillName: skill.name,
    all: scanResult.items,
    forSkill: scanForSkill,
    breakdown: {
      explicit:     scanForSkill.filter((s) => s.status === "explicit").length,
      fromHistory:  scanForSkill.filter((s) => s.status === "from-history").length,
      needsAsking:  scanForSkill.filter((s) => s.status === "needs-asking").length,
    },
  });

  // ── 2.6. 步骤 B：对 needs-asking 的 aspect 拼问题（≥2 个时 LLM 打磨）──
  const questions = await buildQuestionsFromAspects(scanForSkill, skill, llm, runId);

  // ── 1.10. Emit clarify.questions（含 aspectScanResult 供前端审计）──
  emitAndBroadcast(runId, "clarify.questions", {
    questions,
    partial: analysis.req,
    aspectScan: scanForSkill,
  });

  // ── 3. Resolve（仅当有问题要等用户时）──
  runPhase.set(runId, "clarify");
  let req: ClarifiedRequest;
  if (questions.length > 0) {
    const answers = await waitForAnswers(runId);
    req = await clarifyAgent.resolve(rawText, analysis.req, answers, llm);
  } else {
    // 0 问题：直接把 partial + explicit/from-history 的 evidence 当 answers 写入
    const inferredAnswers: Record<string, string> = {};
    for (const item of scanForSkill) {
      if ((item.status === "explicit" || item.status === "from-history") && item.evidence) {
        inferredAnswers[item.aspect] = item.evidence;
      }
    }
    req = { ...analysis.req, answers: inferredAnswers };
  }
  emitAndBroadcast(runId, "clarify.done", { req });

  // ── 用 final req 重新算一遍 plan.files（partial 的 fieldName/businessRule 可能与 PM 实答略异）──
  const plan = await skill.plan(req, ctx);

  runPhase.set(runId, "locate");

  // ── 3. Locate ───────────────────────────────────────────
  let changes;
  try {
    changes = await locateAgent.run(skill, plan, ctx);
  } catch (err) {
    const e = err as { reason?: string; path?: string; message: string };
    emitAndBroadcast(runId, "locate.error", {
      reason: e.reason ?? "unknown",
      path: e.path,
      message: e.message,
    });
    throw err;
  }
  emitAndBroadcast(runId, "locate.done", {
    attempt: locateAttempt,
    files: changes.files,
    fileCount: changes.files.length,
  });
  runPhase.set(runId, "code");

  // ── 4. Code + Verify（最多重试 MAX_VERIFY_RETRIES 次）──
  let currentChanges: ChangeSet = changes;
  let patches = await runCodeAndVerify(runId, skill, currentChanges, llm, repo);

  // ── 5. Commit ───────────────────────────────────────────
  runPhase.set(runId, "commit");
  const branch = `feat/${req.fieldName}-${Date.now()}`;
  await repo.checkoutBranch(branch);
  const commitMsg = `feat: add ${req.fieldName} field\n\n${req.businessRule}`;
  await repo.stageAndCommit(commitMsg);

  const diff = await repo.getDiff("HEAD~1");
  const prDescription = await buildPRDescription(runId, req, diff);

  emitAndBroadcast(runId, "commit.done", {
    branch,
    commitMessage: commitMsg,
    prDescription,
    patchCount: patches.length,
  });

  emitAndBroadcast(runId, "run.completed", { runId });
  runPhase.delete(runId);

  // 异步沉淀 RequestMemory（不阻塞响应；失败仅 warn，不影响 run 状态）
  persistMemory(runId, llm)
    .then((mem) => {
      if (mem) console.log(`[memory] persisted runId=${runId} skill=${mem.skillUsed} entities=${JSON.stringify(mem.entities)}`);
    })
    .catch((err) => console.warn(`[memory] persist failed for runId=${runId}: ${(err as Error).message}`));
}

async function runCodeAndVerify(
  runId: string,
  skill: Skill,
  changes: ChangeSet,
  llm: ReturnType<typeof createDoubaoClient>,
  repo: ReturnType<typeof createConduitRepo>
): Promise<import("./types.js").FilePatch[]> {
  const repo_ = repo;
  let attempt = 1;

  while (true) {
    runPhase.set(runId, `code:attempt${attempt}`);
    // attempt 透传给 base.ts/runLLMOnFile，会进每条 llm.call 事件的 meta
    changes = { ...changes, meta: { ...changes.meta, attempt } };
    const patches = await codeAgent.run(skill, changes, llm, repo_);
    emitAndBroadcast(runId, "code.done", {
      attempt,
      files: patches.map((p) => p.path),
    });

    runPhase.set(runId, `verify:attempt${attempt}`);
    emitAndBroadcast(runId, "verify.running", { attempt });
    const result = await verifyAgent.run(repo_, patches.map((p) => p.path));

    if (result.success) {
      emitAndBroadcast(runId, "verify.done", { attempt, ...result });
      return patches;
    }

    emitAndBroadcast(runId, "verify.failed", {
      attempt,
      exitCode: result.exitCode,
      stderr: result.stderr.slice(0, 1000),
      stdout: result.stdout.slice(0, 1000),
    });

    if (attempt > MAX_VERIFY_RETRIES) {
      throw new Error(`verify 失败，已重试 ${MAX_VERIFY_RETRIES} 次。最后错误：\n${result.stderr.slice(0, 500)}`);
    }

    // 重试：把错误日志加入 meta，attempt + 1
    attempt++;
    changes = {
      ...changes,
      meta: {
        ...changes.meta,
        verifyError: result.stderr.slice(0, 2000),
        verifyStdout: result.stdout.slice(0, 2000),
      },
    };
    console.log(`[orchestrator] verify 失败，第 ${attempt} 次尝试...`);
  }
}

// ────────────────────────────────────────────────────────────
// 重放（从某事件之后丢弃，用新输入重跑）
// ────────────────────────────────────────────────────────────

export async function replayFrom(
  runId: string,
  fromEventIndex: number,
  newRawText: string
): Promise<void> {
  truncateAfter(runId, fromEventIndex);
  emitAndBroadcast(runId, "run.intervened", { fromEventIndex, newRawText });

  const llm = createDoubaoClient({ runId });
  const repo = createConduitRepo();

  runPipeline(runId, newRawText, llm, repo).catch((err) => {
    emitAndBroadcast(runId, "run.error", { message: String(err?.message ?? err) });
  });
}

// ────────────────────────────────────────────────────────────
// 查询
// ────────────────────────────────────────────────────────────

export function getRunEvents(runId: string): RunEvent[] {
  return readEvents(runId);
}

/** PM 在 RecallCard 点"忽略此条历史"时调用：只记事件、不改主流程（前端据此丢弃预填） */
export function dismissRecall(runId: string, historicalRunId: string): boolean {
  const events = readEvents(runId);
  if (!events.length) return false;
  emitAndBroadcast(runId, "recall.dismissed", { historicalRunId });
  return true;
}

export function getRunPhase(runId: string): string | undefined {
  return runPhase.get(runId);
}

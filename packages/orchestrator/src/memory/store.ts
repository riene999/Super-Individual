import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readEvents } from "../events/store.js";
import { extractEntities } from "./extract.js";
import type { RequestMemory, ClarificationQA } from "./types.js";
import type { LLMClient } from "../llm/doubao.js";

const __filename = fileURLToPath(import.meta.url);
// packages/orchestrator/src/memory → ../../../../memory
const DEFAULT_MEMORY_DIR = join(dirname(__filename), "../../../../memory");
const MEMORY_FILE = "store.jsonl";

function getMemoryFile(): string {
  const dir = process.env.MEMORY_DIR ?? DEFAULT_MEMORY_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, MEMORY_FILE);
}

// ────────────────────────────────────────────────────────────
// 读 / 写
// ────────────────────────────────────────────────────────────

export function appendMemory(mem: RequestMemory): void {
  appendFileSync(getMemoryFile(), JSON.stringify(mem) + "\n", "utf8");
}

export function readAllMemories(): RequestMemory[] {
  const file = getMemoryFile();
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n").filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line) as RequestMemory; } catch { return null; }
    })
    .filter((m): m is RequestMemory => m !== null);
}

/** 用于回填覆盖（如重新跑抽取）：按 runId 去重，新条目替换旧条目 */
export function upsertMemory(mem: RequestMemory): void {
  const all = readAllMemories().filter((m) => m.runId !== mem.runId);
  all.push(mem);
  writeFileSync(getMemoryFile(), all.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf8");
}

// ────────────────────────────────────────────────────────────
// 从 events/<runId>.jsonl 重建一个 RequestMemory（除 entities 外）
// ────────────────────────────────────────────────────────────

interface EventLike {
  type: string;
  ts: number;
  payload: Record<string, unknown>;
}

export interface PartialMemory {
  runId: string;
  ts: number;
  summary: string;
  skillUsed: string;
  changedFiles: string[];
  clarifications: ClarificationQA[];
  outcome: "verified" | "failed";
}

/** 从某个 runId 的 jsonl 提取除 entities 之外的所有字段。
 *  无法重建（缺关键事件）时返回 null。 */
export function buildPartialFromEvents(runId: string): PartialMemory | null {
  const events = readEvents(runId) as unknown as EventLike[];
  if (events.length === 0) return null;

  const start = events[0];

  // clarify.done 拿 summary + answers
  const clarifyDone = events.find((e) => e.type === "clarify.done");
  const req = clarifyDone?.payload?.req as Record<string, unknown> | undefined;
  const summary = String(req?.summary ?? "(no summary)");
  const answers = (req?.answers as Record<string, string>) ?? {};

  // 从 clarify.questions 事件取 q→aspect 映射（兼容旧 run：无该事件或无 aspect 字段时落回 "other"）
  const clarifyQuestions = events.find((e) => e.type === "clarify.questions");
  const rawQs = (clarifyQuestions?.payload?.questions ?? []) as Array<{ q?: string; aspect?: string } | string>;
  const aspectMap = new Map<string, string>();
  for (const q of rawQs) {
    if (typeof q === "string") aspectMap.set(q, "other");
    else if (q?.q) aspectMap.set(q.q, q.aspect ?? "other");
  }
  const clarifications: ClarificationQA[] = Object.entries(answers).map(([q, a]) => ({
    q, a, aspect: aspectMap.get(q) ?? "other",
  }));

  // plan.done 拿 skillName
  const planDone = events.find((e) => e.type === "plan.done");
  const skillUsed = String(planDone?.payload?.skillName ?? "");

  // commit.done 优先（含 git 实际 commit 的文件），降级到 code.done.files / locate.done.files
  const commitDone = events.find((e) => e.type === "commit.done");
  const codeDone = events.find((e) => e.type === "code.done");
  const locateDone = events.find((e) => e.type === "locate.done");
  let changedFiles: string[] = [];
  if (commitDone?.payload?.patchCount && codeDone) {
    changedFiles = (codeDone.payload.files as string[]) ?? [];
  } else if (codeDone) {
    changedFiles = (codeDone.payload.files as string[]) ?? [];
  } else if (locateDone) {
    const files = locateDone.payload.files as Array<{ path: string }> | undefined;
    changedFiles = files?.map((f) => f.path) ?? [];
  }

  // outcome：看是否有 run.completed 和 verify.done
  const completed = events.some((e) => e.type === "run.completed");
  const verified = events.some((e) => e.type === "verify.done");
  const outcome: "verified" | "failed" = (completed && verified) ? "verified" : "failed";

  if (!skillUsed || !summary) return null;

  return { runId, ts: start.ts, summary, skillUsed, changedFiles, clarifications, outcome };
}

// ────────────────────────────────────────────────────────────
// 持久化入口：run 完成时由 orchestrator 调用一次
// ────────────────────────────────────────────────────────────

export async function persistMemory(runId: string, llm: LLMClient): Promise<RequestMemory | null> {
  const partial = buildPartialFromEvents(runId);
  if (!partial) {
    console.warn(`[memory] 无法从 events 重建 partial memory for runId=${runId}`);
    return null;
  }

  const entities = await extractEntities(llm, {
    runId,
    summary: partial.summary,
    skillUsed: partial.skillUsed,
    changedFiles: partial.changedFiles,
    clarifications: partial.clarifications,
  });

  const memory: RequestMemory = { ...partial, entities };
  upsertMemory(memory);
  return memory;
}

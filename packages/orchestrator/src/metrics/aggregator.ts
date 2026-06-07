import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
// packages/orchestrator/src/metrics → ../../../../events
const EVENTS_DIR = process.env.EVENTS_DIR ?? join(dirname(__filename), "../../../../events");

// ────────────────────────────────────────────────────────────
// 类型
// ────────────────────────────────────────────────────────────

export interface LLMCallPayload {
  agent: string;
  model: string;
  attempt: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  costCNY: number;
}

export interface LLMCallEvent {
  type: "llm.call";
  runId: string;
  ts: number;
  payload: LLMCallPayload;
}

export interface Stats {
  count: number;
  totalTokens: number;
  totalCostCNY: number;
  /** 以 ms 为单位的 latency 统计 */
  latency: {
    min: number;
    median: number;
    max: number;
    p50: number;  // count<20 时建议前端不显示
    p95: number;  // count<20 时建议前端不显示
  };
}

export interface RunMetrics {
  runId: string;
  hasLlmEvents: boolean;          // 修正 4：旧 run 没 llm.call → false
  calls: Array<{
    agent: string;
    ts: number;
    attempt: number;
    latencyMs: number;
    promptTokens: number;
    completionTokens: number;
    costCNY: number;
  }>;
  byAgent: Record<string, Stats>;
  overall: Stats;
}

export interface GlobalMetrics {
  totalRuns: number;              // 排除 _global.jsonl
  overall: Stats;
  byAgent: Record<string, Stats>;
}

// ────────────────────────────────────────────────────────────
// 统计函数
// ────────────────────────────────────────────────────────────

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

function computeStats(calls: LLMCallPayload[]): Stats {
  const count = calls.length;
  const totalTokens = calls.reduce((s, c) => s + c.promptTokens + c.completionTokens, 0);
  const totalCostCNY = calls.reduce((s, c) => s + c.costCNY, 0);

  const latencies = calls.map((c) => c.latencyMs).sort((a, b) => a - b);
  return {
    count,
    totalTokens,
    totalCostCNY,
    latency: {
      min:    latencies[0] ?? 0,
      max:    latencies[latencies.length - 1] ?? 0,
      median: percentile(latencies, 50),
      p50:    percentile(latencies, 50),
      p95:    percentile(latencies, 95),
    },
  };
}

function groupByAgent(calls: LLMCallPayload[]): Record<string, Stats> {
  const groups: Record<string, LLMCallPayload[]> = {};
  for (const c of calls) {
    (groups[c.agent] ??= []).push(c);
  }
  const result: Record<string, Stats> = {};
  for (const [agent, list] of Object.entries(groups)) {
    result[agent] = computeStats(list);
  }
  return result;
}

// ────────────────────────────────────────────────────────────
// JSONL 读取
// ────────────────────────────────────────────────────────────

function readJsonlEvents(file: string): LLMCallEvent[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter((e) => e?.type === "llm.call") as LLMCallEvent[];
}

// ────────────────────────────────────────────────────────────
// 聚合接口
// ────────────────────────────────────────────────────────────

export function aggregateRun(runId: string): RunMetrics {
  const file = join(EVENTS_DIR, `${runId}.jsonl`);
  const events = readJsonlEvents(file);
  const calls = events.map((e) => e.payload);

  return {
    runId,
    hasLlmEvents: events.length > 0,
    calls: events.map((e) => ({
      agent: e.payload.agent,
      ts: e.ts,
      attempt: e.payload.attempt,
      latencyMs: e.payload.latencyMs,
      promptTokens: e.payload.promptTokens,
      completionTokens: e.payload.completionTokens,
      costCNY: e.payload.costCNY,
    })),
    byAgent: groupByAgent(calls),
    overall: computeStats(calls),
  };
}

// ────────────────────────────────────────────────────────────
// 召回前后对比（WS-3 第 5 档）
// ────────────────────────────────────────────────────────────

export interface RecallComparison {
  baseline: { runId: string; metrics: RunSummary } | null;
  withRecall: { runId: string; metrics: RunSummary } | null;
  diff: RunSummary | null;
}

export interface RunSummary {
  clarifyQuestionsCount: number;
  /** 召回带来的 aspect 精确预填命中数（baseline 必为 0；这是召回的"价值证明"维度） */
  prefillHits: number;
  // WS-4 第 4 档：aspect 三态分布（DISABLE_RECALL / 老 run / 无 aspect.scanned 事件时全 0）
  aspectExplicit: number;
  aspectFromHistory: number;
  aspectNeedsAsking: number;
  totalLLMCalls: number;
  totalTokens: number;
  totalCostCNY: number;
  totalLatencyMs: number;
  hasRecallEvents: boolean;
}

function readAllEvents(runId: string): Array<{ type: string; ts: number; payload: Record<string, unknown> }> {
  const file = join(EVENTS_DIR, `${runId}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

export function summarizeRun(runId: string): RunSummary | null {
  const events = readAllEvents(runId);
  if (events.length === 0) return null;

  const llmCalls = events.filter((e) => e.type === "llm.call").map((e) => e.payload as unknown as LLMCallPayload);
  const clarifyQ = events.find((e) => e.type === "clarify.questions");
  const rawQs = (clarifyQ?.payload?.questions ?? []) as Array<string | { q?: string; aspect?: string }>;
  const clarifyQCount = rawQs.length;

  // prefillHits：当前 run 的每个 clarifyingQuestion 的 aspect，有多少能在 recall.matched 的历史 QA 中找到同 aspect 匹配
  // baseline run 没有 recall.matched 事件 → 必为 0
  const recallMatched = events.find((e) => e.type === "recall.matched");
  let prefillHits = 0;
  if (recallMatched && rawQs.length > 0) {
    const matches = (recallMatched.payload?.matches as Array<{ clarifications: Array<{ aspect?: string }> }>) ?? [];
    const histAspects = new Set<string>();
    for (const m of matches) for (const c of (m.clarifications ?? [])) {
      const asp = c.aspect ?? "other";
      if (asp && asp !== "other") histAspects.add(asp);
    }
    for (const q of rawQs) {
      const asp = typeof q === "string" ? "other" : (q.aspect ?? "other");
      if (asp !== "other" && histAspects.has(asp)) prefillHits++;
    }
  }

  const hasRecallEvents = events.some((e) => e.type === "recall.matched" || e.type === "recall.stale");

  // WS-4：aspect.scanned 事件含每个 aspect 的三态。老 run / DISABLE_RECALL 没这事件 → 全 0
  const aspectScanned = events.find((e) => e.type === "aspect.scanned");
  let aspectExplicit = 0, aspectFromHistory = 0, aspectNeedsAsking = 0;
  if (aspectScanned) {
    const forSkill = (aspectScanned.payload?.forSkill as Array<{ status?: string }>) ?? [];
    for (const it of forSkill) {
      if (it.status === "explicit")     aspectExplicit++;
      else if (it.status === "from-history") aspectFromHistory++;
      else if (it.status === "needs-asking") aspectNeedsAsking++;
    }
  }

  return {
    clarifyQuestionsCount: clarifyQCount,
    prefillHits,
    aspectExplicit, aspectFromHistory, aspectNeedsAsking,
    totalLLMCalls: llmCalls.length,
    totalTokens: llmCalls.reduce((s, c) => s + c.promptTokens + c.completionTokens, 0),
    totalCostCNY: llmCalls.reduce((s, c) => s + c.costCNY, 0),
    totalLatencyMs: llmCalls.reduce((s, c) => s + c.latencyMs, 0),
    hasRecallEvents,
  };
}

export function compareRuns(baselineRunId: string, withRecallRunId: string): RecallComparison {
  const a = summarizeRun(baselineRunId);
  const b = summarizeRun(withRecallRunId);
  const baseline = a ? { runId: baselineRunId, metrics: a } : null;
  const withRecall = b ? { runId: withRecallRunId, metrics: b } : null;
  if (!a || !b) return { baseline, withRecall, diff: null };

  return {
    baseline, withRecall,
    diff: {
      clarifyQuestionsCount: b.clarifyQuestionsCount - a.clarifyQuestionsCount,
      prefillHits: b.prefillHits - a.prefillHits,
      aspectExplicit:    b.aspectExplicit    - a.aspectExplicit,
      aspectFromHistory: b.aspectFromHistory - a.aspectFromHistory,
      aspectNeedsAsking: b.aspectNeedsAsking - a.aspectNeedsAsking,
      totalLLMCalls: b.totalLLMCalls - a.totalLLMCalls,
      totalTokens: b.totalTokens - a.totalTokens,
      totalCostCNY: b.totalCostCNY - a.totalCostCNY,
      totalLatencyMs: b.totalLatencyMs - a.totalLatencyMs,
      hasRecallEvents: b.hasRecallEvents,
    },
  };
}

export function aggregateGlobal(): GlobalMetrics {
  if (!existsSync(EVENTS_DIR)) {
    return { totalRuns: 0, overall: computeStats([]), byAgent: {} };
  }
  const files = readdirSync(EVENTS_DIR).filter((f) => f.endsWith(".jsonl"));
  const runFiles = files.filter((f) => f !== "_global.jsonl");

  const allCalls: LLMCallPayload[] = [];
  for (const f of files) {
    // 全局桶 _global.jsonl 也计入 overall，但不计入 totalRuns
    const events = readJsonlEvents(join(EVENTS_DIR, f));
    allCalls.push(...events.map((e) => e.payload));
  }

  return {
    totalRuns: runFiles.length,
    overall: computeStats(allCalls),
    byAgent: groupByAgent(allCalls),
  };
}

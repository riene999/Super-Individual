/**
 * WS-4 第 2 档：aspectScan 模块纯单测。
 *
 * 覆盖：
 *   1. 正常 explicit/from-history/needs-asking 三态正确返回
 *   2. confidence < 0.7 的 explicit 降级为 needs-asking，rawStatus 保留
 *   3. confidence < 0.7 的 from-history 降级为 needs-asking，evidence 保留
 *   4. LLM 输出非法 aspect（不在 candidate）→ 过滤
 *   5. LLM 输出缺失 aspect → 补全为 needs-asking@confidence=0
 *   6. LLM 输出重复 aspect → 去重
 *   7. LLM 失败 → 兜底全部 needs-asking
 *   8. filterRecallForScan：score<0.5 / failed / >top2 → 过滤
 *   9. candidateAspects 为空 → 直接返回空，不调 LLM
 */
import assert from "assert";
import { aspectScan, filterRecallForScan } from "../packages/orchestrator/src/agents/aspect-scan.js";
import type { AspectScanItem } from "../packages/orchestrator/src/agents/aspect-scan.js";
import type { LLMClient, ChatMeta, Msg, ChatOpts } from "../packages/orchestrator/src/llm/doubao.js";

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`✓ ${name}`); }
  catch (e) { console.error(`✗ ${name}\n   ${(e as Error).message}`); failed++; }
}

function mockLLM(replyText: string | (() => string | Promise<string>) | Error): LLMClient {
  return {
    async chat(_m: Msg[], _o: ChatOpts | undefined, _meta: ChatMeta) {
      if (replyText instanceof Error) throw replyText;
      const text = typeof replyText === "function" ? await replyText() : replyText;
      return { text, usage: { promptTokens: 0, completionTokens: 0, latencyMs: 0, costCNY: 0 } };
    },
  };
}

const ASPECTS = ["field-name", "field-type", "display-position", "calculation-rule"];

// ────────────────────────────────────────────────────────────
// 1. 三态正确返回
// ────────────────────────────────────────────────────────────
await check("三态正确返回 + confidence 保留", async () => {
  const llm = mockLLM(JSON.stringify({
    items: [
      { aspect: "field-name",       status: "explicit",     evidence: "PM 说 readingTime",    confidence: 0.95 },
      { aspect: "field-type",       status: "from-history", evidence: "历史 1 答 VIRTUAL",     confidence: 0.85 },
      { aspect: "display-position", status: "needs-asking",                                   confidence: 1.0 },
      { aspect: "calculation-rule", status: "needs-asking",                                   confidence: 1.0 },
    ],
  }));
  const r = await aspectScan(llm, { runId: "test", rawText: "测试", candidateAspects: ASPECTS, recalledHistory: [] });
  assert.strictEqual(r.items.length, 4);
  const byA = Object.fromEntries(r.items.map((i) => [i.aspect, i])) as Record<string, AspectScanItem>;
  assert.strictEqual(byA["field-name"].status, "explicit");
  assert.strictEqual(byA["field-name"].evidence, "PM 说 readingTime");
  assert.strictEqual(byA["field-name"].rawStatus, undefined);
  assert.strictEqual(byA["field-type"].status, "from-history");
  assert.strictEqual(byA["display-position"].status, "needs-asking");
});

// ────────────────────────────────────────────────────────────
// 2. confidence < 0.7 的 explicit 降级
// ────────────────────────────────────────────────────────────
await check("confidence 0.5 explicit → 降级 needs-asking，rawStatus 保留", async () => {
  const llm = mockLLM(JSON.stringify({
    items: [
      { aspect: "field-name", status: "explicit", evidence: "可能是 readingTime", confidence: 0.5 },
    ],
  }));
  const r = await aspectScan(llm, { runId: "t", rawText: "", candidateAspects: ["field-name"], recalledHistory: [] });
  const it = r.items[0];
  assert.strictEqual(it.status, "needs-asking");
  assert.strictEqual(it.rawStatus, "explicit");
  assert.strictEqual(it.evidence, "可能是 readingTime");  // evidence 留作下游"预填提示"
  assert.strictEqual(it.confidence, 0.5);
});

// ────────────────────────────────────────────────────────────
// 3. confidence < 0.7 的 from-history 降级
// ────────────────────────────────────────────────────────────
await check("confidence 0.6 from-history → 降级 needs-asking，rawStatus + evidence 保留", async () => {
  const llm = mockLLM(JSON.stringify({
    items: [
      { aspect: "field-type", status: "from-history", evidence: "历史可能适用", confidence: 0.6 },
    ],
  }));
  const r = await aspectScan(llm, { runId: "t", rawText: "", candidateAspects: ["field-type"], recalledHistory: [] });
  assert.strictEqual(r.items[0].status, "needs-asking");
  assert.strictEqual(r.items[0].rawStatus, "from-history");
  assert.strictEqual(r.items[0].evidence, "历史可能适用");
});

// ────────────────────────────────────────────────────────────
// 4. 非法 aspect 过滤
// ────────────────────────────────────────────────────────────
await check("非候选 aspect → 过滤", async () => {
  const llm = mockLLM(JSON.stringify({
    items: [
      { aspect: "field-name", status: "explicit", evidence: "x", confidence: 0.9 },
      { aspect: "evil-injected-aspect", status: "explicit", evidence: "y", confidence: 0.9 },
    ],
  }));
  const r = await aspectScan(llm, { runId: "t", rawText: "", candidateAspects: ["field-name"], recalledHistory: [] });
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].aspect, "field-name");
});

// ────────────────────────────────────────────────────────────
// 5. 缺失 aspect 补全
// ────────────────────────────────────────────────────────────
await check("LLM 漏报 aspect → 补全为 needs-asking@confidence=0", async () => {
  const llm = mockLLM(JSON.stringify({
    items: [
      { aspect: "field-name", status: "explicit", evidence: "x", confidence: 0.9 },
    ],
  }));
  const r = await aspectScan(llm, { runId: "t", rawText: "", candidateAspects: ASPECTS, recalledHistory: [] });
  assert.strictEqual(r.items.length, 4);
  const missing = r.items.filter((i) => i.aspect !== "field-name");
  for (const m of missing) {
    assert.strictEqual(m.status, "needs-asking");
    assert.strictEqual(m.confidence, 0);
  }
});

// ────────────────────────────────────────────────────────────
// 6. 重复 aspect 去重
// ────────────────────────────────────────────────────────────
await check("LLM 重复输出 → 去重，留首次", async () => {
  const llm = mockLLM(JSON.stringify({
    items: [
      { aspect: "field-name", status: "explicit",      evidence: "first",  confidence: 0.9 },
      { aspect: "field-name", status: "from-history",  evidence: "second", confidence: 0.8 },
    ],
  }));
  const r = await aspectScan(llm, { runId: "t", rawText: "", candidateAspects: ["field-name"], recalledHistory: [] });
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].evidence, "first");
});

// ────────────────────────────────────────────────────────────
// 7. LLM 失败兜底
// ────────────────────────────────────────────────────────────
await check("LLM throw → 兜底全部 needs-asking", async () => {
  const llm = mockLLM(new Error("network down"));
  const r = await aspectScan(llm, { runId: "t", rawText: "", candidateAspects: ASPECTS, recalledHistory: [] });
  assert.strictEqual(r.items.length, 4);
  for (const it of r.items) {
    assert.strictEqual(it.status, "needs-asking");
    assert.strictEqual(it.confidence, 0);
  }
});

await check("LLM 返回非 JSON → 同样兜底", async () => {
  const llm = mockLLM("hello world, not JSON");
  const r = await aspectScan(llm, { runId: "t", rawText: "", candidateAspects: ASPECTS, recalledHistory: [] });
  assert.strictEqual(r.items.length, 4);
  for (const it of r.items) assert.strictEqual(it.status, "needs-asking");
});

// ────────────────────────────────────────────────────────────
// 8. filterRecallForScan：score<0.5 / failed / >top2 过滤
// ────────────────────────────────────────────────────────────
await check("filterRecallForScan：低分 / failed / 超 topK 都被过滤", () => {
  const matches = [
    { runId: "high-1",  score: 0.9, outcome: "verified", clarifications: [{ q: "q1", a: "a1", aspect: "field-name" }] },
    { runId: "low-1",   score: 0.3, outcome: "verified", clarifications: [] },
    { runId: "high-2",  score: 0.7, outcome: "verified", clarifications: [] },
    { runId: "failed-1",score: 0.95, outcome: "failed",  clarifications: [] },
    { runId: "high-3",  score: 0.6, outcome: "verified", clarifications: [] },
  ];
  const filtered = filterRecallForScan(matches);
  assert.strictEqual(filtered.length, 2, `预期 2 条, 实际 ${filtered.length}: ${filtered.map(m=>m.runId).join(",")}`);
  assert.strictEqual(filtered[0].runId, "high-1");
  assert.strictEqual(filtered[1].runId, "high-2");
});

// ────────────────────────────────────────────────────────────
// 9. 候选 aspect 为空 → 直接返回，不调 LLM
// ────────────────────────────────────────────────────────────
await check("candidateAspects 空 → 直接返回，不触发 LLM", async () => {
  let llmCalled = false;
  const llm: LLMClient = {
    async chat() { llmCalled = true; throw new Error("不应该被调用"); }
  };
  const r = await aspectScan(llm, { runId: "t", rawText: "", candidateAspects: [], recalledHistory: [] });
  assert.strictEqual(r.items.length, 0);
  assert.strictEqual(llmCalled, false);
});

console.log(failed === 0 ? "\n✅ aspect-scan 单测全过" : `\n❌ ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);

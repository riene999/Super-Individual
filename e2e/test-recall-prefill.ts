/**
 * 第 4 档：前端预填三态语义（computePrefill）。
 *
 * - 状态 1（无召回）→ empty
 * - 状态 2（aspect 完全匹配）→ exact，value=历史 a
 * - 状态 3（有召回但 aspect 不匹配）→ hint
 * - dismissedRunIds 中的历史不参与
 * - aspect="other" 时不走精确预填
 */
import assert from "assert";
import { computePrefill } from "../apps/web/src/recallTypes.js";
import type { RecallMatchView, ClarifyingQ } from "../apps/web/src/recallTypes.js";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (e) { console.error(`✗ ${name}\n   ${(e as Error).message}`); failed++; }
}

const HISTORICAL: RecallMatchView = {
  runId: "hist-A",
  score: 0.82,
  matchedDimensions: ["同样的操作类型", "涉及相同对象: article"],
  summary: "在文章卡片显示阅读时长",
  skillUsed: "add-field",
  outcome: "verified",
  expectedFiles: [],
  clarifications: [
    { q: "用什么算法?", a: "200字/分钟", aspect: "calculation-rule" },
    { q: "显示在哪?",   a: "日期后",     aspect: "display-position" },
  ],
};

check("状态 1：无召回 → empty", () => {
  const q: ClarifyingQ = { q: "阅读速度怎么定?", aspect: "calculation-rule" };
  const r = computePrefill(q, [], new Set());
  assert.strictEqual(r.mode, "empty");
});

check("状态 2：aspect 完全匹配 → exact, value=200字/分钟", () => {
  const q: ClarifyingQ = { q: "阅读速度怎么定?", aspect: "calculation-rule" };
  const r = computePrefill(q, [HISTORICAL], new Set());
  assert.strictEqual(r.mode, "exact");
  if (r.mode === "exact") {
    assert.strictEqual(r.value, "200字/分钟");
    assert.strictEqual(r.sourceLabel, "上次答的");
    assert.strictEqual(r.sourceRunId, "hist-A");
  }
});

check("状态 3：有召回但 aspect 不匹配 → hint", () => {
  const q: ClarifyingQ = { q: "怎么排序?", aspect: "sort-rule" };
  const r = computePrefill(q, [HISTORICAL], new Set());
  assert.strictEqual(r.mode, "hint");
  if (r.mode === "hint") {
    assert(r.hint.includes("上次类似问题答过"));
    assert.strictEqual(r.sourceRunId, "hist-A");
  }
});

check("aspect='other' 强制走 hint 或 empty（不精确预填）", () => {
  const q: ClarifyingQ = { q: "随便问问?", aspect: "other" };
  const r = computePrefill(q, [HISTORICAL], new Set());
  // 应进 hint 模式（有 top-1 召回的第一条 QA 可作提示）
  assert.strictEqual(r.mode, "hint");
});

check("dismissedRunIds 中的历史不参与", () => {
  const q: ClarifyingQ = { q: "阅读速度怎么定?", aspect: "calculation-rule" };
  const r = computePrefill(q, [HISTORICAL], new Set(["hist-A"]));
  assert.strictEqual(r.mode, "empty");
});

check("多条召回时优先取 aspect 匹配的", () => {
  const NO_MATCH_HIGHER_SCORE: RecallMatchView = {
    ...HISTORICAL,
    runId: "hist-B",
    score: 0.99,
    clarifications: [{ q: "页面叫啥?", a: "Profile", aspect: "page-name" }],
  };
  const q: ClarifyingQ = { q: "用什么算法?", aspect: "calculation-rule" };
  // 顺序：hist-B（分数高但 aspect 不匹配）, hist-A（aspect 匹配）
  // computePrefill 按顺序遍历，先看 hist-B 的 clarifications 没有 calculation-rule，再看 hist-A 的有
  const r = computePrefill(q, [NO_MATCH_HIGHER_SCORE, HISTORICAL], new Set());
  assert.strictEqual(r.mode, "exact");
  if (r.mode === "exact") assert.strictEqual(r.sourceRunId, "hist-A");
});

console.log(failed === 0 ? "\n✅ prefill 三态全过" : `\n❌ ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);

/**
 * 第 2 档：召回器纯单测。
 * 6 类场景覆盖 score() / recall()：同 skill 高分、跨 skill 区分、failed 降权、minScore、topK、空候选。
 */
import assert from "assert";
import { score, recall } from "../packages/orchestrator/src/memory/recall.js";
import {
  M_FIELD, M_FIELD_2, M_FILTER, M_PAGE, M_FAILED_TWIN, ALL,
} from "./fixtures/memory.js";

let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    console.error(`✗ ${name}\n   ${(e as Error).message}`);
    failed++;
  }
}

// ────────────────────────────────────────────────────────────
// 1. 同 skill 高度召回：M_FIELD entities → 候选[F2, FILTER, PAGE] 应让 F2 排第一
// ────────────────────────────────────────────────────────────
check("同 skill 高度召回：F2 应排第一且分数 >= 0.6", () => {
  const results = recall(M_FIELD.entities, [M_FIELD_2, M_FILTER, M_PAGE], { topK: 3, minScore: 0 });
  assert(results.length === 3, `期望 3 条，实际 ${results.length}`);
  assert.strictEqual(results[0].memory.runId, M_FIELD_2.runId, `top1 应为 F2`);
  assert(results[0].score >= 0.6, `F2 分数 ${results[0].score} < 0.6`);
  // 顺序：F2 > FILTER > PAGE
  assert(results[0].score > results[1].score && results[1].score >= results[2].score,
    `期望降序：[${results.map(r => r.score.toFixed(2)).join(", ")}]`);
});

// ────────────────────────────────────────────────────────────
// 2. failed 降权 0.5×：自相似 + outcome=failed 应严格是 verified 的 0.5
// ────────────────────────────────────────────────────────────
check("failed 降权 0.5×：自相似 verified 1.0 → failed 0.5", () => {
  const sV = score(M_FIELD.entities, M_FIELD);          // 自相似 verified
  const sF = score(M_FIELD.entities, M_FAILED_TWIN);    // 自相似 failed twin
  assert(Math.abs(sV.score - 1.0) < 1e-9, `verified 自相似应为 1.0，实际 ${sV.score}`);
  assert(Math.abs(sF.score - 0.5) < 1e-9, `failed 自相似应为 0.5，实际 ${sF.score}`);
  // matched 维度数量应相同（降权不影响维度判定）
  assert.strictEqual(sV.matchedDimensions.length, sF.matchedDimensions.length,
    "matched 维度数量不应因 outcome 改变");
});

// ────────────────────────────────────────────────────────────
// 3. minScore 过滤：跨 skill 配对 0.4 / 0.25 应被 minScore=0.5 全过滤
// ────────────────────────────────────────────────────────────
check("minScore 过滤：M_FIELD entities + minScore=0.5 应过滤掉 FILTER 和 PAGE", () => {
  const results = recall(M_FIELD.entities, [M_FILTER, M_PAGE], { topK: 3, minScore: 0.5 });
  assert.strictEqual(results.length, 0, `期望 0 条，实际 ${results.length}（${results.map(r => `${r.memory.skillUsed}=${r.score.toFixed(2)}`).join(", ")}）`);
});

// ────────────────────────────────────────────────────────────
// 4. topK 截断：5 条候选中只取 top 1
// ────────────────────────────────────────────────────────────
check("topK 截断：5 条候选只取 top 1", () => {
  const results = recall(M_FIELD.entities, ALL, { topK: 1, minScore: 0 });
  assert.strictEqual(results.length, 1, `期望 1 条，实际 ${results.length}`);
  // 应为 M_FIELD 自身 (=1.0) — ALL 包含 M_FIELD
  assert.strictEqual(results[0].memory.runId, M_FIELD.runId);
});

// ────────────────────────────────────────────────────────────
// 5. 空候选：返回 []
// ────────────────────────────────────────────────────────────
check("空候选：返回空数组", () => {
  const results = recall(M_FIELD.entities, [], { topK: 3, minScore: 0 });
  assert.strictEqual(results.length, 0);
});

// ────────────────────────────────────────────────────────────
// 6. matchedDimensions 准确性：F2 vs F 应命中三大维度（操作 + 对象 + 组件）
// ────────────────────────────────────────────────────────────
check("matchedDimensions 准确：F2 vs F 应命中操作 + 对象 + 组件三大维度", () => {
  const r = score(M_FIELD.entities, M_FIELD_2);
  const dims = r.matchedDimensions.join("|");
  assert(dims.includes("同样的操作类型"), `缺操作维度: ${dims}`);
  assert(dims.includes("article"), `缺对象维度: ${dims}`);
  assert(dims.includes("ArticleMeta"), `缺组件维度: ${dims}`);
  // F2 vs F 都涉及 ArticleMeta + ArticlesPreview，必命中组件
});

// ────────────────────────────────────────────────────────────
// 7. 边界：matched 不应包含未命中维度
// ────────────────────────────────────────────────────────────
check("边界：跨 skill 时不应误报组件维度", () => {
  // M_FIELD 涉及 ArticleMeta/ArticlesPreview，M_FILTER 涉及 FeedToggler，无交集
  const r = score(M_FIELD.entities, M_FILTER);
  assert(!r.matchedDimensions.some(d => d.startsWith("涉及相同组件")),
    `不应有组件维度命中：${r.matchedDimensions.join(" / ")}`);
  assert(!r.matchedDimensions.some(d => d.startsWith("同样的操作类型")),
    `不应有操作维度命中：${r.matchedDimensions.join(" / ")}`);
});

console.log(failed === 0 ? "\n✅ recall 单测全过" : `\n❌ ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);

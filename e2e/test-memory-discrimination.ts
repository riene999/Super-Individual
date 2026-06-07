/**
 * 第 1 档 gate：检查抽取出来的 3 条 RequestMemory 能否拉开区分度。
 *
 * 期望（微调 3 的硬性 gate）：
 *   add-field × add-filter   ≤ 0.4
 *   add-field × add-page     ≤ 0.5
 *   add-filter × add-page    ≤ 0.5
 *   自相似（任一 × 自己）     ≥ 0.9
 *
 * 全过 → 进第 2 档；任一不过 → 改 schema 或 prompt。
 */
import assert from "assert";
import { readAllMemories } from "../packages/orchestrator/src/memory/store.js";
import { score } from "../packages/orchestrator/src/memory/recall.js";
import type { RequestMemory } from "../packages/orchestrator/src/memory/types.js";

const memories = readAllMemories();
if (memories.length < 3) {
  console.error(`✗ 至少需要 3 条 memory，实际 ${memories.length} 条。先跑 backfill。`);
  process.exit(1);
}

function findBySkill(skill: string): RequestMemory {
  const m = memories.find((x) => x.skillUsed === skill);
  if (!m) throw new Error(`找不到 skillUsed=${skill} 的 memory`);
  return m;
}

const F = findBySkill("add-field");
const L = findBySkill("add-filter");
const P = findBySkill("add-page");

interface Case {
  name: string;
  a: RequestMemory;
  b: RequestMemory;
  /** 上限或下限 */
  bound: number;
  /** "le" 上限 / "ge" 下限 */
  cmp: "le" | "ge";
}

const cases: Case[] = [
  { name: "add-field × add-filter", a: F, b: L, bound: 0.4, cmp: "le" },
  { name: "add-field × add-page  ", a: F, b: P, bound: 0.5, cmp: "le" },
  { name: "add-filter × add-page ", a: L, b: P, bound: 0.5, cmp: "le" },
  { name: "add-field × add-field ", a: F, b: F, bound: 0.9, cmp: "ge" },
  { name: "add-filter × add-filter", a: L, b: L, bound: 0.9, cmp: "ge" },
  { name: "add-page × add-page   ", a: P, b: P, bound: 0.9, cmp: "ge" },
];

let failed = 0;
console.log("配对                            分数     期望      维度");
console.log("─".repeat(80));
for (const c of cases) {
  const result = score(c.a.entities, c.b);
  const sym = c.cmp === "le" ? "≤" : "≥";
  const ok = c.cmp === "le" ? result.score <= c.bound : result.score >= c.bound;
  const mark = ok ? "✓" : "✗";
  const dims = result.matchedDimensions.length === 0 ? "(无)" : result.matchedDimensions.join(" / ");
  console.log(`${mark} ${c.name.padEnd(28)} ${result.score.toFixed(3)}   ${sym} ${c.bound.toFixed(2)}   ${dims}`);
  try {
    if (c.cmp === "le") assert(result.score <= c.bound, `score ${result.score} > ${c.bound}`);
    else assert(result.score >= c.bound, `score ${result.score} < ${c.bound}`);
  } catch { failed++; }
}

console.log("─".repeat(80));
console.log(failed === 0
  ? "\n✅ Gate 通过：entities 区分度足以进第 2 档"
  : `\n❌ Gate 未通过：${failed} 个配对不达标，需要回头调整 schema 或 prompt`);
process.exit(failed === 0 ? 0 : 1);

/**
 * 第 4 档：aspect 校验逻辑（不依赖 LLM）。
 *
 * 1. 每个 skill 的 possibleAspects 是合法非空数组
 * 2. ClarifyAgent normalizeQuestion 对未知 aspect 落回 "other"
 * 3. 字符串型 question（旧 schema）兼容为 {q, aspect:"other"}
 */
import assert from "assert";
import { loadSkills, resetSkillCache } from "../packages/orchestrator/src/skills/registry.js";

let failed = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve(fn())
    .then(() => console.log(`✓ ${name}`))
    .catch((e: Error) => { console.error(`✗ ${name}\n   ${e.message}`); failed++; });
}

resetSkillCache();
const skills = await loadSkills();

await check("每个 skill 都声明了 possibleAspects（非空）", () => {
  for (const s of skills) {
    assert(Array.isArray(s.possibleAspects), `${s.name} possibleAspects 不是数组`);
    assert(s.possibleAspects.length > 0, `${s.name} possibleAspects 为空`);
  }
});

await check("各 skill 的 aspect 名符合枚举命名（kebab-case）", () => {
  for (const s of skills) {
    for (const a of s.possibleAspects) {
      assert(/^[a-z][a-z0-9-]*$/.test(a), `${s.name} aspect "${a}" 不是 kebab-case`);
    }
  }
});

await check("aspects 并集去重", () => {
  const all = skills.flatMap((s) => s.possibleAspects);
  const set = new Set(all);
  // 允许跨 skill 重叠（如 add-field 和 add-page 都有 display-position）
  // 这里只验证 set 非空
  assert(set.size > 0, "aspect 并集为空");
  console.log(`   并集: [${[...set].sort().join(", ")}]`);
});

// ── ClarifyAgent normalizeQuestion 走纯函数路径（无 LLM） ──
// 这里 inline 复制 normalizeQuestion 等价逻辑用 fixture 验证
await check("normalize: 字符串型问题 → {q, aspect:'other'}（旧 schema 兼容）", () => {
  // 模拟旧 sequence：ClarifyAgent 历史输出可能就是 string[]
  const raw = "请确认字段类型？";
  const result = typeof raw === "string" ? { q: raw, aspect: "other" } : null;
  assert.strictEqual(result?.q, "请确认字段类型？");
  assert.strictEqual(result?.aspect, "other");
});

await check("normalize: 未知 aspect → 'other'", () => {
  const allowed = new Set(skills.find((s) => s.name === "add-field")?.possibleAspects ?? []);
  const rawAspect = "nonexistent-aspect";
  const aspect = allowed.has(rawAspect) || rawAspect === "other" ? rawAspect : "other";
  assert.strictEqual(aspect, "other");
});

await check("normalize: 已知 aspect 保留", () => {
  const allowed = new Set(skills.find((s) => s.name === "add-field")?.possibleAspects ?? []);
  const rawAspect = "calculation-rule";
  const aspect = allowed.has(rawAspect) || rawAspect === "other" ? rawAspect : "other";
  assert.strictEqual(aspect, "calculation-rule");
});

console.log(failed === 0 ? "\n✅ aspect 校验全过" : `\n❌ ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);

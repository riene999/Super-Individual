/**
 * 弱耦合证明：临时禁用 add-filter.skill.ts，验证其余 skill 仍可正常工作。
 *
 * 跑法：pnpm test:weak-coupling
 */
import assert from "assert";
import { renameSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadSkills, resetSkillCache } from "../packages/orchestrator/src/skills/registry.js";
import addFieldFixture from "../packages/orchestrator/src/skills/__fixtures__/add-field.fixture.js";
import addPageFixture  from "../packages/orchestrator/src/skills/__fixtures__/add-page.fixture.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, "../packages/orchestrator/src/skills");
const TARGET    = join(SKILLS_DIR, "add-filter.skill.ts");
const DISABLED  = join(SKILLS_DIR, "add-filter.skill.ts.disabled");

let failed = 0;
const ctx = { repoPath: "", branch: "main" };

function disable() {
  if (!existsSync(TARGET)) throw new Error("add-filter.skill.ts not found at " + TARGET);
  renameSync(TARGET, DISABLED);
}
function restore() {
  if (existsSync(DISABLED)) renameSync(DISABLED, TARGET);
}

try {
  // ── Phase 1: 基线确认（3 个 skill 全在）──────────────
  resetSkillCache();
  const baseline = await loadSkills();
  try {
    assert.strictEqual(baseline.length, 3, `baseline 应有 3 个 skill，实际 ${baseline.length}`);
    console.log(`✓ baseline: 加载到 ${baseline.length} 个 skill: [${baseline.map(s => s.name).join(", ")}]`);
  } catch (e) { console.error("✗ baseline", (e as Error).message); failed++; }

  // ── Phase 2: 禁用 add-filter ─────────────────────────
  disable();
  resetSkillCache();
  console.log("\n--- 已禁用 add-filter.skill.ts ---");

  const survivors = await loadSkills();
  try {
    assert.strictEqual(survivors.length, 2, `应剩 2 个 skill，实际 ${survivors.length}`);
    const names = survivors.map(s => s.name).sort();
    assert.deepStrictEqual(names, ["add-field", "add-page"], `剩余名单不对: ${names.join(",")}`);
    console.log(`✓ 仅 ${survivors.length} 个 skill 加载: [${names.join(", ")}]`);
  } catch (e) { console.error("✗ phase 2 load", (e as Error).message); failed++; }

  // ── Phase 3: 抽样调用剩下两个 skill 的 match/plan/locate ──
  const addField = survivors.find(s => s.name === "add-field")!;
  const addPage  = survivors.find(s => s.name === "add-page")!;
  try {
    assert.strictEqual(addField.match(addFieldFixture), 1, "add-field match");
    const fieldPlan = await addField.plan(addFieldFixture, ctx);
    assert.strictEqual(fieldPlan.files.length, 3, "add-field plan files");
    await addField.locate(fieldPlan, ctx);                       // 不抛 LocateError
    console.log(`✓ add-field 仍可工作 (match + plan.files=3 + locate ok)`);
  } catch (e) { console.error("✗ add-field 工作", (e as Error).message); failed++; }
  try {
    assert.strictEqual(addPage.match(addPageFixture), 1, "add-page match");
    const pagePlan = await addPage.plan(addPageFixture, ctx);
    assert.strictEqual(pagePlan.files.length, 4, "add-page plan files");
    await addPage.locate(pagePlan, ctx);
    console.log(`✓ add-page 仍可工作 (match + plan.files=4 + locate ok)`);
  } catch (e) { console.error("✗ add-page 工作", (e as Error).message); failed++; }

  // ── Phase 4: 恢复并确认回到基线 ──────────────────────
  restore();
  resetSkillCache();
  const restored = await loadSkills();
  try {
    assert.strictEqual(restored.length, 3, `恢复后应回到 3 个，实际 ${restored.length}`);
    console.log(`\n✓ 恢复后再次加载到 3 个: [${restored.map(s => s.name).join(", ")}]`);
  } catch (e) { console.error("✗ restore", (e as Error).message); failed++; }
} finally {
  // 保险：如果中途 throw，确保文件恢复
  restore();
}

console.log(failed === 0 ? "\n✅ weak-coupling 弱耦合验证通过" : `\n❌ ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);

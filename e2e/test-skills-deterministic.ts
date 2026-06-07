/**
 * 确定性 smoke test（修正 1）：不调用 LLM，只验 match / locate / FileStep 文本。
 * 跑法：pnpm test:skills
 * 退出码非 0 即失败。
 */
import assert from "assert";
import { loadSkills, resetSkillCache, scoreAllSkills } from "../packages/orchestrator/src/skills/registry.js";
import addFieldFixture  from "../packages/orchestrator/src/skills/__fixtures__/add-field.fixture.js";
import addFilterFixture from "../packages/orchestrator/src/skills/__fixtures__/add-filter.fixture.js";
import addPageFixture   from "../packages/orchestrator/src/skills/__fixtures__/add-page.fixture.js";
import type { ClarifiedRequest } from "../packages/orchestrator/src/types.js";

type Case = {
  name: string;
  fixture: ClarifiedRequest;
  minScore: number;                                 // 自匹配下限
  expectedFiles: Array<{ path: string; mode: "modify" | "create"; instructionIncludes: string }>;
};

const CASES: Case[] = [
  {
    name: "add-field",
    fixture: addFieldFixture,
    minScore: 0.75,
    expectedFiles: [
      { path: "backend/models/Article.js",                                       mode: "modify", instructionIncludes: "readingTime" },
      { path: "frontend/src/components/ArticleMeta/ArticleMeta.jsx",             mode: "modify", instructionIncludes: "readingTime" },
      { path: "frontend/src/components/ArticlesPreview/ArticlesPreview.jsx",     mode: "modify", instructionIncludes: "readingTime" },
    ],
  },
  {
    name: "add-filter",
    fixture: addFilterFixture,
    minScore: 0.75,
    expectedFiles: [
      { path: "backend/controllers/articles.js",                                 mode: "modify", instructionIncludes: "lengthCategory" },
      { path: "frontend/src/services/getArticles.js",                            mode: "modify", instructionIncludes: "lengthCategory" },
      { path: "frontend/src/hooks/useArticles.js",                               mode: "modify", instructionIncludes: "lengthCategory" },
      { path: "frontend/src/components/FeedToggler/FeedToggler.jsx",             mode: "modify", instructionIncludes: "FeedToggler" },
    ],
  },
  {
    name: "add-page",
    fixture: addPageFixture,
    minScore: 0.75,
    expectedFiles: [
      // 路径由 fieldName=popularTags 推导：fileBase=popularTags, pageName=PopularTags, routeUrl=popular-tags
      { path: "backend/routes/popularTags.js",                                   mode: "create", instructionIncludes: "Express Router" },
      { path: "backend/index.js",                                                mode: "modify", instructionIncludes: "/api/popular-tags" },
      { path: "frontend/src/routes/PopularTags.jsx",                             mode: "create", instructionIncludes: "/api/popular-tags" },
      { path: "frontend/src/main.jsx",                                           mode: "modify", instructionIncludes: "PopularTags" },
    ],
  },
];

resetSkillCache();
const skills = await loadSkills();
let failed = 0;

const ctx = { repoPath: "", branch: "main" };

for (const c of CASES) {
  const skill = skills.find((s) => s.name === c.name);
  if (!skill) { console.error(`✗ skill "${c.name}" not loaded`); failed++; continue; }

  try {
    const score = skill.match(c.fixture);
    assert(score >= c.minScore, `match score: expected ≥ ${c.minScore}, got ${score}`);
    console.log(`✓ ${c.name}: match=${score}`);
  } catch (e) { console.error(`✗ ${c.name}: match`, (e as Error).message); failed++; }

  const plan = await skill.plan(c.fixture, ctx);
  try {
    assert.strictEqual(plan.files.length, c.expectedFiles.length, `files count`);
    c.expectedFiles.forEach((exp, i) => {
      assert.strictEqual(plan.files[i].path, exp.path, `file[${i}].path`);
      assert.strictEqual(plan.files[i].mode, exp.mode, `file[${i}].mode`);
      assert.ok(
        plan.files[i].instruction.includes(exp.instructionIncludes),
        `file[${i}].instruction missing "${exp.instructionIncludes}"`,
      );
    });
    console.log(`✓ ${c.name}: plan.files (${plan.files.length} files, all paths+modes+instructions match)`);
  } catch (e) { console.error(`✗ ${c.name}: plan.files`, (e as Error).message); failed++; }

  try {
    const changes = await skill.locate(plan, ctx);
    const planPaths = plan.files.map((f) => f.path);
    const changePaths = changes.files.map((f) => f.path);
    assert.deepStrictEqual(changePaths, planPaths, "locate.files paths must match plan.files paths");
    console.log(`✓ ${c.name}: locate (no LocateError, ${changes.files.length} files)`);
  } catch (e) { console.error(`✗ ${c.name}: locate`, (e as Error).message); failed++; }
}

// ── 跨验证：requiredWords 硬否决 + skill 不应被对方 fixture 错误命中 ──
console.log("\n--- 跨验证 ---");
const fieldSkill  = skills.find((s) => s.name === "add-field")!;
const filterSkill = skills.find((s) => s.name === "add-filter")!;

try {
  const wrong1 = filterSkill.match(addFieldFixture);
  assert.strictEqual(wrong1, 0, `add-filter should reject add-field fixture (requiredWords)，got ${wrong1}`);
  console.log(`✓ add-filter 拒绝 add-field fixture (requiredWords 硬否决, score=0)`);
} catch (e) { console.error("✗ 跨验证: add-filter on add-field", (e as Error).message); failed++; }

try {
  const fieldScore  = fieldSkill.match(addFieldFixture);
  const filterScore = filterSkill.match(addFieldFixture);
  assert(fieldScore > filterScore, `add-field fixture: add-field score (${fieldScore}) must beat add-filter score (${filterScore})`);
  console.log(`✓ add-field fixture: add-field 得分 (${fieldScore}) > add-filter 得分 (${filterScore})`);
} catch (e) { console.error("✗ 跨验证 1", (e as Error).message); failed++; }

try {
  const fieldScore  = fieldSkill.match(addFilterFixture);
  const filterScore = filterSkill.match(addFilterFixture);
  assert(filterScore > fieldScore, `add-filter fixture: add-filter score (${filterScore}) must beat add-field score (${fieldScore})`);
  console.log(`✓ add-filter fixture: add-filter 得分 (${filterScore}) > add-field 得分 (${fieldScore})`);
} catch (e) { console.error("✗ 跨验证 2", (e as Error).message); failed++; }

// add-page 应仅被 add-page 命中
const pageSkill = skills.find((s) => s.name === "add-page")!;
try {
  const pageScore   = pageSkill.match(addPageFixture);
  const fieldScore  = fieldSkill.match(addPageFixture);
  const filterScore = filterSkill.match(addPageFixture);
  assert(pageScore > fieldScore && pageScore > filterScore,
    `add-page fixture: page=${pageScore} field=${fieldScore} filter=${filterScore}`);
  console.log(`✓ add-page fixture: add-page 得分 (${pageScore}) > add-field (${fieldScore}) / add-filter (${filterScore})`);
} catch (e) { console.error("✗ 跨验证 3", (e as Error).message); failed++; }

// ── 路由决策快路径验证（修正 4）：所有 fixture 必须走 keyword 路径，不应触发 LLM ──
console.log("\n--- 路由决策快路径验证 ---");
const TOP1_CONFIDENCE_THRESHOLD = 0.5;
const TOP1_TOP2_GAP_THRESHOLD = 0.3;

for (const c of CASES) {
  const scored = await scoreAllSkills(c.fixture);
  const top1 = scored[0];
  const top2 = scored[1];
  const triggers: string[] = [];
  if (top1.score < TOP1_CONFIDENCE_THRESHOLD) triggers.push(`top1<${TOP1_CONFIDENCE_THRESHOLD}`);
  if (top2 && top1.score - top2.score < TOP1_TOP2_GAP_THRESHOLD) triggers.push(`gap<${TOP1_TOP2_GAP_THRESHOLD}`);
  try {
    assert.strictEqual(triggers.length, 0,
      `${c.name} fixture 不应触发 LLM 兜底，但满足条件 ${triggers.join(",")} (top1=${top1.score.toFixed(2)} top2=${top2?.score.toFixed(2) ?? "n/a"})`);
    assert.strictEqual(top1.skill.name, c.name,
      `${c.name} fixture 的 top1 必须是自己，但是 ${top1.skill.name}`);
    console.log(`✓ ${c.name}: 走 keyword 快路径 (top1=${top1.skill.name}@${top1.score.toFixed(2)}, gap=${(top1.score - (top2?.score ?? 0)).toFixed(2)})`);
  } catch (e) { console.error(`✗ ${c.name}: 路由决策`, (e as Error).message); failed++; }
}

console.log(failed === 0 ? "\n✅ all deterministic tests passed" : `\n❌ ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);

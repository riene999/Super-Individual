/**
 * WS-4 第 1 档自检：aspectQuestionTemplate 必填 + 运行时校验。
 *
 * 覆盖：
 *   1. 正常 skill 加载成功（三个真实 skill）
 *   2. 缺整个 template 字段 → throw
 *   3. 缺某 aspect 条目 → throw（错误信息含 skill 名 + aspect 名）
 *   4. question 为空字符串 → throw
 *   5. example 为空字符串 → throw（必含例子的硬约束）
 *   6. template 含未声明的多余 aspect → throw（防拼写漂移）
 *   7. 真实 skill template 的 example 不能是占位词（必须含"例如"字样）
 */
import assert from "assert";
import { defineSkill } from "../packages/orchestrator/src/skills/base.js";
import { loadSkills, resetSkillCache } from "../packages/orchestrator/src/skills/registry.js";

let failed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn())
    .then(() => console.log(`✓ ${name}`))
    .catch((e: Error) => { console.error(`✗ ${name}\n   ${e.message}`); failed++; });
}

function expectThrow(fn: () => void, snippet: string): void {
  try { fn(); throw new Error("expected throw but didn't"); }
  catch (e) {
    const msg = (e as Error).message;
    if (!msg.includes(snippet)) {
      throw new Error(`throw 消息不含期望片段 "${snippet}"。实际: ${msg}`);
    }
  }
}

// ── 1. 真实三个 skill 都能正常 defineSkill ──
await check("baseline: 真实三个 skill 加载成功", async () => {
  resetSkillCache();
  const skills = await loadSkills();
  assert.strictEqual(skills.length, 3);
  for (const s of skills) {
    assert(Object.keys(s.aspectQuestionTemplate).length === s.possibleAspects.length,
      `${s.name}: template 条目数 (${Object.keys(s.aspectQuestionTemplate).length}) ≠ possibleAspects 数 (${s.possibleAspects.length})`);
  }
});

// ── 2. 缺 template 字段 ──
await check("缺 aspectQuestionTemplate 字段 → throw + 错误信息含 skill 名", () => {
  expectThrow(() => defineSkill({
    name: "broken-1", description: "", matchWords: [],
    possibleAspects: ["foo"],
    // 故意不写 aspectQuestionTemplate
    buildSteps: () => [],
  } as Parameters<typeof defineSkill>[0]), "broken-1");
});

// ── 3. 缺单条 aspect 条目 ──
await check("缺 aspect 条目 → throw 信息含具体 aspect 名", () => {
  expectThrow(() => defineSkill({
    name: "broken-2", description: "", matchWords: [],
    possibleAspects: ["foo", "bar"],
    aspectQuestionTemplate: { foo: { question: "q", example: "e" } },  // 缺 bar
    buildSteps: () => [],
  }), `"bar"`);
});

// ── 4. question 空 ──
await check("question 空字符串 → throw", () => {
  expectThrow(() => defineSkill({
    name: "broken-3", description: "", matchWords: [],
    possibleAspects: ["foo"],
    aspectQuestionTemplate: { foo: { question: "   ", example: "e" } },
    buildSteps: () => [],
  }), "question 为空");
});

// ── 5. example 空 ──
await check("example 空字符串 → throw（example 是硬约束）", () => {
  expectThrow(() => defineSkill({
    name: "broken-4", description: "", matchWords: [],
    possibleAspects: ["foo"],
    aspectQuestionTemplate: { foo: { question: "q", example: "" } },
    buildSteps: () => [],
  }), "example 为空");
});

// ── 6. template 含多余 aspect ──
await check("template 含未声明 aspect → throw（防拼写漂移）", () => {
  expectThrow(() => defineSkill({
    name: "broken-5", description: "", matchWords: [],
    possibleAspects: ["foo"],
    aspectQuestionTemplate: {
      foo:  { question: "q", example: "e" },
      bar:  { question: "q", example: "e" },  // bar 不在 possibleAspects
    },
    buildSteps: () => [],
  }), `"bar"`);
});

// ── 7. 真实 template 必须含"例如"字样（fewshot 硬约束） ──
await check("真实 skill 的 example 必须含「例如」字样（fewshot 约束）", async () => {
  resetSkillCache();
  const skills = await loadSkills();
  for (const s of skills) {
    for (const [aspect, tmpl] of Object.entries(s.aspectQuestionTemplate)) {
      assert(tmpl.example.includes("例如") || /e\.g\.|for example/i.test(tmpl.example),
        `${s.name}.${aspect}: example "${tmpl.example}" 缺少"例如"或"e.g."`);
    }
  }
});

console.log(failed === 0 ? "\n✅ aspect template 校验全过" : `\n❌ ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);

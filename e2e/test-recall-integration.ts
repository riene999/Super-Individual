/**
 * 第 3 档自检：召回管线的集成行为，不调 LLM。
 *
 * 三组断言（用户指定）：
 *   1. extract 入参可选：query 模式（无 changedFiles）应返回合法 entities，uiSurfaces=[]
 *   2. stale 路径检测：混合输入下应识别出失效文件
 *   3. stale 不影响主流程：locate 仍可基于 plan 产出合法 ChangeSet
 *
 * 第 1 项用 mock LLM 完成；第 2、3 项用真实 conduit 文件系统验证。
 */
import assert from "assert";
import { extractEntities } from "../packages/orchestrator/src/memory/extract.js";
import { validateRecalledFiles } from "../packages/orchestrator/src/memory/validate.js";
import { createConduitRepo } from "../packages/orchestrator/src/repo/conduit.js";
import { loadSkills } from "../packages/orchestrator/src/skills/registry.js";
import { score } from "../packages/orchestrator/src/memory/recall.js";
import { M_STALE } from "./fixtures/memory-stale.js";
import addFieldFixture from "../packages/orchestrator/src/skills/__fixtures__/add-field.fixture.js";
import type { LLMClient, ChatMeta } from "../packages/orchestrator/src/llm/doubao.js";

let failed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn())
    .then(() => console.log(`✓ ${name}`))
    .catch((e: Error) => { console.error(`✗ ${name}\n   ${e.message}`); failed++; });
}

// ────────────────────────────────────────────────────────────
// 1. extract 入参可选（mock LLM）
// ────────────────────────────────────────────────────────────
const mockLLM: LLMClient = {
  async chat(messages, _opts, _meta: ChatMeta) {
    // 返回符合 schema 的固定 JSON，模拟 LLM 在 query 模式的合理推测
    const text = JSON.stringify({
      domainObjects: ["article"],
      operations: ["add-virtual-field"],
      fieldsAdded: ["readingTime"],
      uiSurfaces: ["ArticleMeta", "ArticlesPreview"], // 故意给一个，验证 extract 是否清空
    });
    return { text, usage: { promptTokens: messages.length, completionTokens: 10, latencyMs: 0, costCNY: 0 } };
  },
};

await check("extract query 模式（无 changedFiles）应返回合法 entities 且 uiSurfaces=[]", async () => {
  const ent = await extractEntities(mockLLM, {
    runId: "test-query",
    summary: "在文章卡片显示阅读时长",
    skillUsed: "add-field",
    // 不传 changedFiles / clarifications
  });
  assert.deepStrictEqual(ent.domainObjects, ["article"]);
  assert.deepStrictEqual(ent.operations, ["add-virtual-field"]);
  assert.deepStrictEqual(ent.fieldsAdded, ["readingTime"]);
  assert.deepStrictEqual(ent.uiSurfaces, [], "query 模式 uiSurfaces 必须为 []");
  assert.deepStrictEqual(ent.affectedLayers, [], "无 changedFiles → affectedLayers 应为 []");
});

await check("extract 沉淀模式（有 changedFiles）uiSurfaces 应被填充", async () => {
  const ent = await extractEntities(mockLLM, {
    runId: "test-persist",
    summary: "在文章卡片显示阅读时长",
    skillUsed: "add-field",
    changedFiles: ["backend/models/Article.js", "frontend/src/components/ArticleMeta/ArticleMeta.jsx"],
    clarifications: [{ q: "速度？", a: "200" }],
  });
  assert(ent.uiSurfaces.length > 0, "沉淀模式 uiSurfaces 应非空");
  assert(ent.affectedLayers.length > 0, "沉淀模式 affectedLayers 应非空（规则推导）");
  assert(ent.affectedLayers.includes("db"));
  assert(ent.affectedLayers.includes("frontend"));
});

// ────────────────────────────────────────────────────────────
// 2. stale 路径检测（混合：1 真实 + 2 失效）
// ────────────────────────────────────────────────────────────
const repo = createConduitRepo();
await check("validateRecalledFiles：混合输入下识别 valid / stale", () => {
  const { valid, stale } = validateRecalledFiles(repo, M_STALE.changedFiles);
  assert.strictEqual(valid.length, 1, `valid 应为 1（Article.js 存在），实际 ${valid.length}`);
  assert.strictEqual(stale.length, 2, `stale 应为 2（OLD.jsx ×2），实际 ${stale.length}`);
  assert(valid[0].endsWith("Article.js"));
  assert(stale.every((p) => p.includes(".OLD.")));
});

// ────────────────────────────────────────────────────────────
// 3. stale 不影响主流程：locate 仍能产出合法 ChangeSet
// ────────────────────────────────────────────────────────────
await check("stale 后纯 skill 路径仍能 locate 出合法 ChangeSet", async () => {
  const skills = await loadSkills();
  const addField = skills.find((s) => s.name === "add-field")!;
  const plan = await addField.plan(addFieldFixture, { repoPath: "", branch: "main" });
  // 直接走 locate（模拟 stale 后的纯 skill 回退路径）
  const changes = await addField.locate(plan, { repoPath: "", branch: "main" });
  assert.strictEqual(changes.files.length, 3, `期望 3 个文件，实际 ${changes.files.length}`);
  assert(changes.files.every((f) => f.path && f.reason), "每个文件应有 path 和 reason");
});

// ────────────────────────────────────────────────────────────
// 4. M_STALE 应被召回为高分（这是触发 stale 的前提）
// ────────────────────────────────────────────────────────────
await check("M_STALE 与 add-field 自相似 entities 召回分数应 >= 0.9", () => {
  const result = score(M_STALE.entities, M_STALE);
  assert(result.score >= 0.9, `自相似分数 ${result.score} < 0.9`);
});

console.log(failed === 0 ? "\n✅ recall 集成自检全过" : `\n❌ ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);

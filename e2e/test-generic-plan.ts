import assert from "assert";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { planAgent } from "../packages/orchestrator/src/agents/plan.js";
import addFieldFixture from "../packages/orchestrator/src/skills/__fixtures__/add-field.fixture.js";
import type { ClarifiedRequest } from "../packages/orchestrator/src/types.js";
import type { LLMClient, Msg, ChatOpts, ChatMeta } from "../packages/orchestrator/src/llm/doubao.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const conduitPath = join(__dirname, "../workspace/conduit");

function mockLLM(): { llm: LLMClient; agents: string[] } {
  const agents: string[] = [];
  const llm: LLMClient = {
    async chat(_messages: Msg[], _opts: ChatOpts | undefined, meta: ChatMeta) {
      agents.push(meta.agent);
      if (meta.agent === "plan:router") {
        return {
          text: JSON.stringify({ picked: "none", reason: "不属于现有 add-field/add-filter/add-page 模式" }),
          usage: { promptTokens: 0, completionTokens: 0, latencyMs: 0, costCNY: 0 },
        };
      }
      if (meta.agent === "plan:generic") {
        return {
          text: JSON.stringify({
            files: [
              {
                path: "frontend/src/routes/Profile/Profile.jsx",
                mode: "modify",
                instruction: "在现有 My Articles / Favorited Articles tab 旁新增 About Me tab，并显示当前 profile.bio。",
              },
              {
                path: "frontend/src/components/UserBio.jsx",
                mode: "create",
                instruction: "创建展示用户 bio 的轻量组件，bio 为空时显示默认空态。",
              },
            ],
          }),
          usage: { promptTokens: 0, completionTokens: 0, latencyMs: 0, costCNY: 0 },
        };
      }
      throw new Error(`unexpected LLM agent: ${meta.agent}`);
    },
  };
  return { llm, agents };
}

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    console.error(`✗ ${name}\n   ${(e as Error).message}`);
    failed++;
  }
}

const ctx = { repoPath: conduitPath, branch: "main" };

await check("未命中 skill 时返回 generic plan，不抛错", async () => {
  const req: ClarifiedRequest = {
    summary: "在 Profile 页面现有 My Articles / Favorited Articles 之外新增 About Me Tab，展示 User.bio",
    fieldName: "aboutMe",
    fieldType: "string",
    displayLocation: "Profile 页面 tabs 区域",
    businessRule: "点击 About Me tab 时显示用户 bio",
    clarifyingQuestions: [],
  };
  const { llm, agents } = mockLLM();
  const result = await planAgent.run(req, ctx, llm);

  assert.strictEqual(result.mode, "generic");
  assert.strictEqual(result.skill, null);
  assert.strictEqual(result.plan.skillName, "generic");
  assert.deepStrictEqual(result.plan.files.map((f) => f.path), [
    "frontend/src/routes/Profile/Profile.jsx",
    "frontend/src/components/UserBio.jsx",
  ]);
  assert.deepStrictEqual(agents, ["plan:router", "plan:generic"]);
});

await check("已有 skill 高置信命中时仍走 skill 快路径", async () => {
  const { llm, agents } = mockLLM();
  const result = await planAgent.run(addFieldFixture, ctx, llm);

  assert.strictEqual(result.mode, "skill");
  assert.strictEqual(result.skill?.name, "add-field");
  assert.strictEqual(result.plan.skillName, "add-field");
  assert.deepStrictEqual(agents, []);
});

console.log(failed === 0 ? "\n✓ generic-plan tests passed" : `\n✗ ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);

import { scoreAllSkills } from "../skills/registry.js";
import type { ClarifiedRequest, RepoContext, SkillPlan, Skill } from "../types.js";
import type { LLMClient } from "../llm/doubao.js";

// 触发 LLM 兜底的两个条件（修正 4）
const TOP1_CONFIDENCE_THRESHOLD = 0.5;   // top1 < 此值 → 没人有把握
const TOP1_TOP2_GAP_THRESHOLD = 0.3;     // 差距 < 此值 → 拉锯，LLM 仲裁

export type RoutingDecision = "keyword" | "llm-router";

export interface PlanResult {
  skill: Skill;
  plan: SkillPlan;
  score: number;
  /** 路由决策：快路径还是 LLM 兜底 */
  by: RoutingDecision;
  /** 全量 skill 评分快照，写到事件 payload 用 */
  candidates: Array<{ name: string; score: number }>;
  /** 当 by === "llm-router" 时给出 LLM 的选型理由 */
  routerReason?: string;
}

interface Candidate {
  skill: Skill;
  score: number;
}

const ROUTER_SYSTEM = `你是需求路由器。在给定候选 skill 列表中挑出最贴合 PM 需求的一项，或返回 "none"。只输出 JSON。`;

async function llmRoute(
  req: ClarifiedRequest,
  candidates: Candidate[],
  llm: LLMClient,
): Promise<{ pickedName: string; reason: string }> {
  const list = candidates
    .map((c, i) => `${i + 1}. ${c.skill.name} (关键词分=${c.score.toFixed(2)}) — ${c.skill.description}`)
    .join("\n");

  const result = await llm.chat([
    { role: "system", content: ROUTER_SYSTEM },
    {
      role: "user",
      content: `PM 需求摘要：${req.summary}
字段名：${req.fieldName}
业务规则：${req.businessRule}
展示位置：${req.displayLocation}

候选 skill：
${list}

请挑出最合适的 skill，或返回 "none"。输出格式：{"picked":"<skill-name|none>","reason":"<一句话>"}`,
    },
  ], undefined, { agent: "plan:router" });

  const cleaned = result.text.replace(/^```[a-z]*\n?/m, "").replace(/```$/m, "").trim();
  const data = JSON.parse(cleaned) as { picked?: string; reason?: string };
  return { pickedName: data.picked ?? "none", reason: data.reason ?? "" };
}

function shouldFallback(scored: Candidate[]): boolean {
  if (scored.length === 0) return true;
  const top1 = scored[0];
  if (top1.score < TOP1_CONFIDENCE_THRESHOLD) return true;
  const top2 = scored[1];
  if (top2 && top1.score - top2.score < TOP1_TOP2_GAP_THRESHOLD) return true;
  return false;
}

export const planAgent = {
  async run(req: ClarifiedRequest, ctx: RepoContext, llm: LLMClient): Promise<PlanResult> {
    const scored = await scoreAllSkills(req);
    const candidates = scored.map((c) => ({ name: c.skill.name, score: c.score }));

    if (!shouldFallback(scored)) {
      const top = scored[0];
      const plan = await top.skill.plan(req, ctx);
      console.log(`[plan] by=keyword skill=${top.skill.name} score=${top.score.toFixed(2)}`);
      return { skill: top.skill, plan, score: top.score, by: "keyword", candidates };
    }

    // LLM 兜底
    if (scored.length === 0) throw new Error("没有任何已注册的 skill");
    console.log(`[plan] 触发 LLM 兜底 (top1=${scored[0].score.toFixed(2)}, top2=${scored[1]?.score.toFixed(2) ?? "n/a"})`);

    const { pickedName, reason } = await llmRoute(req, scored, llm);
    if (pickedName === "none") {
      throw new Error(`LLM 兜底选型：no skill matches. reason: ${reason}`);
    }
    const picked = scored.find((c) => c.skill.name === pickedName);
    if (!picked) {
      throw new Error(`LLM 兜底返回未知 skill: "${pickedName}". reason: ${reason}`);
    }

    const plan = await picked.skill.plan(req, ctx);
    console.log(`[plan] by=llm-router skill=${picked.skill.name} reason="${reason}"`);
    return {
      skill: picked.skill,
      plan,
      score: picked.score,
      by: "llm-router",
      candidates,
      routerReason: reason,
    };
  },
};

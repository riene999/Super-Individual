import { scoreAllSkills } from "../skills/registry.js";
import { genericPlan } from "./generic-plan.js";
import type { ClarifiedRequest, RepoContext, SkillPlan, Skill } from "../types.js";
import type { LLMClient } from "../llm/doubao.js";

const TOP1_CONFIDENCE_THRESHOLD = 0.5;
const TOP1_TOP2_GAP_THRESHOLD = 0.3;

export type RoutingDecision = "keyword" | "llm-router";
export type PlanMode = "skill" | "generic";

export interface PlanResult {
  mode: PlanMode;
  skill: Skill | null;
  plan: SkillPlan;
  score: number;
  by: RoutingDecision;
  candidates: Array<{ name: string; score: number }>;
  routerReason?: string;
  genericReason?: string;
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
    .map((c, i) => `${i + 1}. ${c.skill.name}（关键词分=${c.score.toFixed(2)}）- ${c.skill.description}`)
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

请选择最合适的 skill，或返回 "none"。输出格式：{"picked":"<skill-name|none>","reason":"<一句话理由>"}`,
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

async function runGeneric(
  req: ClarifiedRequest,
  ctx: RepoContext,
  llm: LLMClient,
  args: {
    score: number;
    candidates: Array<{ name: string; score: number }>;
    routerReason?: string;
    genericReason: string;
  },
): Promise<PlanResult> {
  const plan = await genericPlan(req, ctx, llm);
  console.log(`[plan] mode=generic reason="${args.genericReason}"`);
  return {
    mode: "generic",
    skill: null,
    plan,
    score: args.score,
    by: "llm-router",
    candidates: args.candidates,
    routerReason: args.routerReason,
    genericReason: args.genericReason,
  };
}

export const planAgent = {
  async run(req: ClarifiedRequest, ctx: RepoContext, llm: LLMClient): Promise<PlanResult> {
    const scored = await scoreAllSkills(req);
    const candidates = scored.map((c) => ({ name: c.skill.name, score: c.score }));

    if (!shouldFallback(scored)) {
      const top = scored[0];
      const plan = await top.skill.plan(req, ctx);
      console.log(`[plan] by=keyword skill=${top.skill.name} score=${top.score.toFixed(2)}`);
      return { mode: "skill", skill: top.skill, plan, score: top.score, by: "keyword", candidates };
    }

    if (scored.length === 0) {
      return runGeneric(req, ctx, llm, {
        score: 0,
        candidates,
        genericReason: "没有已注册的 skill",
      });
    }

    console.log(`[plan] 触发 LLM 兜底 (top1=${scored[0].score.toFixed(2)}, top2=${scored[1]?.score.toFixed(2) ?? "n/a"})`);
    const { pickedName, reason } = await llmRoute(req, scored, llm);

    if (pickedName === "none") {
      return runGeneric(req, ctx, llm, {
        score: scored[0]?.score ?? 0,
        candidates,
        routerReason: reason,
        genericReason: `没有 skill 达到阈值；最佳候选 ${scored[0]?.skill.name ?? "none"}=${(scored[0]?.score ?? 0).toFixed(2)}`,
      });
    }

    const picked = scored.find((c) => c.skill.name === pickedName);
    if (!picked) {
      return runGeneric(req, ctx, llm, {
        score: scored[0]?.score ?? 0,
        candidates,
        routerReason: reason,
        genericReason: `LLM router 返回未知 skill: ${pickedName}`,
      });
    }

    if (picked.score < TOP1_CONFIDENCE_THRESHOLD) {
      return runGeneric(req, ctx, llm, {
        score: picked.score,
        candidates,
        routerReason: reason,
        genericReason: `LLM router 选择 ${picked.skill.name}=${picked.score.toFixed(2)}，低于阈值 ${TOP1_CONFIDENCE_THRESHOLD}`,
      });
    }

    const plan = await picked.skill.plan(req, ctx);
    console.log(`[plan] by=llm-router skill=${picked.skill.name} reason="${reason}"`);
    return {
      mode: "skill",
      skill: picked.skill,
      plan,
      score: picked.score,
      by: "llm-router",
      candidates,
      routerReason: reason,
    };
  },
};

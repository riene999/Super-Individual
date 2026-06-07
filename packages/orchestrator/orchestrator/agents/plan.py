from __future__ import annotations

import json
from dataclasses import dataclass

from orchestrator.agents.generic_plan import generic_plan
from orchestrator.llm.doubao import LLMClient
from orchestrator.skills.base import Skill
from orchestrator.skills.registry import score_all_skills
from orchestrator.types import ClarifiedRequest, RepoContext, SkillPlan

TOP1_CONFIDENCE_THRESHOLD = 0.5
TOP1_TOP2_GAP_THRESHOLD = 0.3


@dataclass
class PlanResult:
    mode: str
    skill: Skill | None
    plan: SkillPlan
    score: float
    by: str
    candidates: list[dict[str, float | str]]
    routerReason: str | None = None
    genericReason: str | None = None


def _should_fallback(scored: list[dict[str, object]]) -> bool:
    if not scored:
        return True
    top1 = scored[0]
    top1_score = float(top1["score"])
    if top1_score < TOP1_CONFIDENCE_THRESHOLD:
        return True
    if len(scored) > 1 and top1_score - float(scored[1]["score"]) < TOP1_TOP2_GAP_THRESHOLD:
        return True
    return False


async def _llm_route(req: ClarifiedRequest, scored: list[dict[str, object]], llm: LLMClient) -> dict[str, str]:
    lines = []
    for i, item in enumerate(scored, start=1):
        skill = item["skill"]
        assert isinstance(skill, Skill)
        lines.append(f"{i}. {skill.name}（关键词分={float(item['score']):.2f}）- {skill.description}")
    result = await llm.chat(
        [
            {"role": "system", "content": '你是需求路由器。在给定候选 skill 列表中挑出最贴合 PM 需求的一项，或返回 "none"。只输出 JSON。'},
            {
                "role": "user",
                "content": f"""PM 需求摘要：{req.summary}
字段名：{req.fieldName}
业务规则：{req.businessRule}
展示位置：{req.displayLocation}

候选 skill：
{chr(10).join(lines)}

请选择最合适的 skill，或返回 "none"。输出格式：{{"picked":"<skill-name|none>","reason":"<一句话理由>"}}""",
            },
        ],
        None,
        {"agent": "plan:router"},
    )
    return json.loads(result["text"].strip().removeprefix("```json").removesuffix("```").strip())


async def _run_generic(
    req: ClarifiedRequest,
    ctx: RepoContext,
    llm: LLMClient,
    *,
    score: float,
    candidates: list[dict[str, float | str]],
    generic_reason: str,
    router_reason: str | None = None,
) -> PlanResult:
    plan = await generic_plan(req, ctx, llm)
    return PlanResult("generic", None, plan, score, "llm-router", candidates, router_reason, generic_reason)


async def run(req: ClarifiedRequest, ctx: RepoContext, llm: LLMClient) -> PlanResult:
    scored = await score_all_skills(req)
    candidates = [{"name": cast_skill["skill"].name, "score": float(cast_skill["score"])} for cast_skill in scored]  # type: ignore[attr-defined]
    if not _should_fallback(scored):
        top = scored[0]
        skill = top["skill"]
        assert isinstance(skill, Skill)
        plan = await skill.plan(req, ctx)
        return PlanResult("skill", skill, plan, float(top["score"]), "keyword", candidates)

    if not scored:
        return await _run_generic(req, ctx, llm, score=0, candidates=candidates, generic_reason="没有已注册的 skill")

    routed = await _llm_route(req, scored, llm)
    picked_name = routed.get("picked", "none")
    reason = routed.get("reason", "")
    if picked_name == "none":
        top = scored[0]
        skill = top["skill"]
        assert isinstance(skill, Skill)
        return await _run_generic(
            req,
            ctx,
            llm,
            score=float(top["score"]),
            candidates=candidates,
            router_reason=reason,
            generic_reason=f"没有 skill 达到阈值；最佳候选 {skill.name}={float(top['score']):.2f}",
        )
    picked = next((x for x in scored if isinstance(x["skill"], Skill) and x["skill"].name == picked_name), None)
    if not picked:
        return await _run_generic(
            req,
            ctx,
            llm,
            score=float(scored[0]["score"]),
            candidates=candidates,
            router_reason=reason,
            generic_reason=f"LLM router 返回未知 skill: {picked_name}",
        )
    skill = picked["skill"]
    assert isinstance(skill, Skill)
    if float(picked["score"]) < TOP1_CONFIDENCE_THRESHOLD:
        return await _run_generic(
            req,
            ctx,
            llm,
            score=float(picked["score"]),
            candidates=candidates,
            router_reason=reason,
            generic_reason=f"LLM router 选择 {skill.name}={float(picked['score']):.2f}，低于阈值 {TOP1_CONFIDENCE_THRESHOLD}",
        )
    return PlanResult("skill", skill, await skill.plan(req, ctx), float(picked["score"]), "llm-router", candidates, reason)


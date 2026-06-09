from orchestrator.skills.base import Skill
from orchestrator.types import ChangeSet, RepoContext, SkillPlan


async def run(skill: Skill, plan: SkillPlan, ctx: RepoContext) -> ChangeSet:
    return await skill.locate(plan, ctx)


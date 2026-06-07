from __future__ import annotations

from orchestrator.skills.add_field import add_field
from orchestrator.skills.add_filter import add_filter
from orchestrator.skills.add_page import add_page
from orchestrator.skills.base import Skill
from orchestrator.types import ClarifiedRequest

_CACHE: list[Skill] | None = None


async def load_skills() -> list[Skill]:
    global _CACHE
    if _CACHE is None:
        _CACHE = [add_page, add_filter, add_field]
    return _CACHE


def reset_skill_cache() -> None:
    global _CACHE
    _CACHE = None


async def score_all_skills(req: ClarifiedRequest) -> list[dict[str, object]]:
    skills = await load_skills()
    return sorted(({"skill": skill, "score": skill.match(req)} for skill in skills), key=lambda x: float(x["score"]), reverse=True)


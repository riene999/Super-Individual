from orchestrator.llm.doubao import LLMClient
from orchestrator.repo.conduit import ConduitRepo
from orchestrator.skills.base import Skill
from orchestrator.types import ChangeSet, FilePatch


async def run(skill: Skill, changes: ChangeSet, llm: LLMClient, repo: ConduitRepo) -> list[FilePatch]:
    patches = await skill.generate(changes, llm, repo)
    repo.apply_patches(patches)
    return patches


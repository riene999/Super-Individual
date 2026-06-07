import type { Skill, ChangeSet, FilePatch } from "../types.js";
import type { LLMClient } from "../llm/doubao.js";
import type { ConduitRepo } from "../repo/conduit.js";

export const codeAgent = {
  async run(
    skill: Skill,
    changes: ChangeSet,
    llm: LLMClient,
    repo: ConduitRepo
  ): Promise<FilePatch[]> {
    const patches = await skill.generate(changes, llm);
    repo.applyPatches(patches);
    console.log(`[code] 已写入 ${patches.length} 个文件`);
    return patches;
  },
};

import type { Skill, SkillPlan, RepoContext, ChangeSet } from "../types.js";

export const locateAgent = {
  async run(skill: Skill, plan: SkillPlan, ctx: RepoContext): Promise<ChangeSet> {
    const changes = await skill.locate(plan, ctx);
    console.log(`[locate] ${changes.files.length} 个文件: ${changes.files.map(f => f.path).join(", ")}`);
    return changes;
  },
};

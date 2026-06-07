import { glob } from "glob";
import { pathToFileURL } from "url";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { Skill, ClarifiedRequest } from "../types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let _cache: Skill[] | null = null;

/** 扫描本目录下所有 *.skill.ts，动态 import，缓存结果。新增 skill 只需加文件，无需修改此处。 */
export async function loadSkills(): Promise<Skill[]> {
  if (_cache) return _cache;

  const files = await glob("*.skill.ts", { cwd: __dirname });
  const skills: Skill[] = [];

  for (const file of files) {
    const url = pathToFileURL(join(__dirname, file)).href;
    const mod = await import(url);
    const skill = mod.default as Skill | undefined;
    if (skill?.name && typeof skill.match === "function") {
      skills.push(skill);
      console.log(`[registry] loaded skill: ${skill.name}`);
    }
  }

  _cache = skills;
  return skills;
}

/** 重置缓存（用于测试或热重载） */
export function resetSkillCache(): void {
  _cache = null;
}

/** 选出最佳 skill，score > 0 才返回 */
export async function findBestSkill(
  req: ClarifiedRequest
): Promise<{ skill: Skill; score: number } | null> {
  const skills = await loadSkills();
  let best: { skill: Skill; score: number } | null = null;

  for (const skill of skills) {
    const score = skill.match(req);
    if (!best || score > best.score) best = { skill, score };
  }

  return best && best.score > 0 ? best : null;
}

/** 给每个 skill 打分并按分数降序返回，供 PlanAgent 走 LLM 兜底时使用 */
export async function scoreAllSkills(
  req: ClarifiedRequest
): Promise<Array<{ skill: Skill; score: number }>> {
  const skills = await loadSkills();
  return skills
    .map((skill) => ({ skill, score: skill.match(req) }))
    .sort((a, b) => b.score - a.score);
}

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { defaultGenerate, defaultLocate } from "../skills/base.js";
import type { ClarifiedRequest, FileStep, RepoContext, Skill, SkillPlan } from "../types.js";
import type { LLMClient } from "../llm/doubao.js";

const MAX_GENERIC_FILES = 6;

function listDir(root: string, relative: string, depth: number): string[] {
  const dir = join(root, relative);
  if (!existsSync(dir) || depth < 0) return [];

  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === "build") continue;
    const rel = relative ? `${relative}/${entry}` : entry;
    const full = join(root, rel);
    const stat = statSync(full);
    out.push(stat.isDirectory() ? `${rel}/` : rel);
    if (stat.isDirectory()) out.push(...listDir(root, rel, depth - 1));
  }
  return out;
}

function safeRead(root: string, relative: string): string {
  const file = join(root, relative);
  if (!existsSync(file)) return "(文件不存在)";
  return readFileSync(file, "utf8").split("\n").slice(0, 180).join("\n");
}

function listFiles(root: string, relative: string): string[] {
  const dir = join(root, relative);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => `${relative}/${name}`);
}

export function getRepoOverview(ctx: RepoContext): string {
  const root = ctx.repoPath;
  return [
    `仓库路径：${root}`,
    `当前分支：${ctx.branch}`,
    "--- 目录树（最多 2 层）---",
    listDir(root, "", 2).slice(0, 220).join("\n"),
    "--- 前端入口文件 ---",
    `--- frontend/src/App.jsx ---\n${safeRead(root, "frontend/src/App.jsx")}`,
    `--- frontend/src/main.jsx ---\n${safeRead(root, "frontend/src/main.jsx")}`,
    "--- 前端页面文件 ---",
    listFiles(root, "frontend/src/routes").join("\n"),
    listFiles(root, "frontend/src/routes/Profile").join("\n"),
    "--- 后端路由注册 ---",
    safeRead(root, "backend/index.js"),
    "--- 后端路由文件 ---",
    listFiles(root, "backend/routes").join("\n"),
    "--- 后端模型文件 ---",
    listFiles(root, "backend/models").join("\n"),
  ].join("\n");
}

function parsePlan(text: string): FileStep[] {
  const cleaned = text.replace(/^```[a-z]*\n?/m, "").replace(/```$/m, "").trim();
  const data = JSON.parse(cleaned) as { files?: Array<Partial<FileStep>> };
  if (!Array.isArray(data.files)) throw new Error("genericPlan 没有返回 files 数组");

  return data.files.slice(0, MAX_GENERIC_FILES).map((f, i) => {
    const path = String(f.path ?? "").trim();
    const mode = f.mode === "create" ? "create" : f.mode === "modify" ? "modify" : null;
    const instruction = String(f.instruction ?? "").trim();
    if (!path) throw new Error(`genericPlan.files[${i}] 缺少 path`);
    if (!mode) throw new Error(`genericPlan.files[${i}] mode 必须是 modify 或 create`);
    if (!instruction) throw new Error(`genericPlan.files[${i}] 缺少 instruction`);
    return { path, mode, instruction };
  });
}

export async function genericPlan(
  req: ClarifiedRequest,
  ctx: RepoContext,
  llm: LLMClient,
): Promise<SkillPlan> {
  const repoOverview = getRepoOverview(ctx);
  const result = await llm.chat([
    {
      role: "system",
      content: "你是资深代码规划助手。只输出严格 JSON，不要输出 markdown 或解释。",
    },
    {
      role: "user",
      content: `分析下面的产品需求，并提出需要修改或新建的文件清单。

需求摘要：${req.summary}
字段名：${req.fieldName}
字段类型：${req.fieldType}
展示位置：${req.displayLocation}
业务规则：${req.businessRule}

仓库概览：
${repoOverview}

输出 JSON，格式必须是：
{"files":[{"path":"相对路径","mode":"modify|create","instruction":"具体实现说明"}]}

要求：
- path 必须相对 Conduit 仓库根目录。
- mode="modify" 时，path 必须是真实存在的文件，或能从仓库概览中明确判断为已存在文件。
- mode="create" 时，path 必须放在符合现有约定的位置。
- 不要超过 6 个文件；典型需求控制在 2-4 个文件。
- instruction 要写清楚本文件具体改什么，不能只写“修改这个文件”。`,
    },
  ], { temperature: 0.1, maxTokens: 1600 }, { agent: "plan:generic" });

  return { skillName: "generic", files: parsePlan(result.text) };
}

export const genericSkill: Skill = {
  name: "generic",
  description: "未命中注册 skill 时使用的通用推理路径",
  possibleAspects: [],
  aspectQuestionTemplate: {},
  match: () => 0,
  async plan() {
    throw new Error("genericSkill.plan 需要 LLM，请直接调用 genericPlan(req, ctx, llm)");
  },
  locate: defaultLocate,
  generate: defaultGenerate,
};

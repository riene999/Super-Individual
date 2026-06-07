import { createConduitRepo } from "../repo/conduit.js";
import type {
  Skill, ClarifiedRequest, RepoContext, SkillPlan, ChangeSet, FilePatch, FileStep, FileChange,
} from "../types.js";
import type { LLMClient } from "../llm/doubao.js";

// ────────────────────────────────────────────────────────────
// 定位错误（修正 3）
// ────────────────────────────────────────────────────────────

export type LocateErrorReason = "missing_modify_target" | "create_target_exists";

export class LocateError extends Error {
  constructor(public reason: LocateErrorReason, public path: string, public skillName: string) {
    super(`[${skillName}] ${reason}: ${path}`);
    this.name = "LocateError";
  }
}

// ────────────────────────────────────────────────────────────
// 关键词打分（含必选词硬否决，修正 4）
// ────────────────────────────────────────────────────────────

export interface KeywordMatchOpts {
  threshold: number;          // 命中 N 个词 ⇒ 满分
  requiredWords?: string[];   // 必选词：若一个都不命中，直接返回 0
}

export function keywordMatch(
  req: ClarifiedRequest,
  words: string[],
  opts: KeywordMatchOpts,
): number {
  const haystack = [req.summary, req.fieldName, req.businessRule, req.displayLocation]
    .join(" ").toLowerCase();

  if (opts.requiredWords?.length) {
    const hit = opts.requiredWords.some((w) => haystack.includes(w.toLowerCase()));
    if (!hit) return 0;
  }

  const hits = words.filter((w) => haystack.includes(w.toLowerCase())).length;
  return Math.min(hits / opts.threshold, 1.0);
}

// ────────────────────────────────────────────────────────────
// Locate：按 FileStep 读现文件 / 校验 create 目标不存在
// ────────────────────────────────────────────────────────────

export type ReferenceProvider = (step: FileStep, ctx: RepoContext) => string | null;

export async function defaultLocate(
  plan: SkillPlan,
  _ctx: RepoContext,
  referenceFor?: ReferenceProvider,
): Promise<ChangeSet> {
  const repo = createConduitRepo();
  const files: FileChange[] = [];
  const context: Record<string, string> = {};
  const references: Record<string, { path: string; content: string }> = {};

  for (const step of plan.files) {
    const current = repo.readFileOrNull(step.path);

    if (step.mode === "modify") {
      if (current === null) throw new LocateError("missing_modify_target", step.path, plan.skillName);
      context[step.path] = current;
    } else { // create
      if (current !== null) throw new LocateError("create_target_exists", step.path, plan.skillName);
      context[step.path] = "";
      if (referenceFor) {
        const refPath = referenceFor(step, _ctx);
        if (refPath) {
          const refContent = repo.readFileOrNull(refPath);
          if (refContent) references[step.path] = { path: refPath, content: refContent };
        }
      }
    }

    files.push({ path: step.path, reason: step.instruction });
  }

  return {
    files,
    context,
    meta: { skillName: plan.skillName, steps: plan.files, references },
  };
}

// ────────────────────────────────────────────────────────────
// Generate：逐文件调 LLM，按 mode 选 prompt 模板
// ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `你是专业代码助手。
规则：
1. 只返回完整文件内容，不加 markdown 代码块、不加任何解释。
2. 保持目标项目的风格、缩进、引号约定。
3. 不引入未使用的依赖。`;

function modifyPrompt(path: string, current: string, instruction: string): string {
  return `文件路径：${path}

当前内容：
${current}

修改任务：
${instruction}

返回完整的修改后文件内容：`;
}

function createPrompt(
  path: string,
  instruction: string,
  reference?: { path: string; content: string },
): string {
  const refBlock = reference
    ? `\n参考样例文件（${reference.path}），请参照其结构、import 约定、命名风格：\n${reference.content}\n`
    : "";
  return `从空白新建文件：${path}
${refBlock}
创建任务：
${instruction}

返回该文件的完整内容：`;
}

export async function runLLMOnFile(
  llm: LLMClient,
  path: string,
  currentContent: string,
  mode: "modify" | "create",
  instruction: string,
  reference: { path: string; content: string } | undefined,
  meta: { agent: string; attempt: number },
): Promise<FilePatch> {
  const user = mode === "modify"
    ? modifyPrompt(path, currentContent, instruction)
    : createPrompt(path, instruction, reference);

  const result = await llm.chat(
    [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: user }],
    { temperature: 0.1, maxTokens: 4096 },
    { agent: meta.agent, attempt: meta.attempt },
  );
  return { path, newContent: result.text };
}

export async function defaultGenerate(changes: ChangeSet, llm: LLMClient): Promise<FilePatch[]> {
  const steps = (changes.meta?.steps as FileStep[]) ?? [];
  const refs = (changes.meta?.references as Record<string, { path: string; content: string }>) ?? {};
  const skillName = String(changes.meta?.skillName ?? "unknown");
  const attempt = Number(changes.meta?.attempt ?? 1);
  const patches: FilePatch[] = [];

  for (let i = 0; i < changes.files.length; i++) {
    const fc = changes.files[i];
    const step = steps[i];
    if (!step) continue;
    const current = changes.context[fc.path] ?? "";
    const patch = await runLLMOnFile(
      llm, fc.path, current, step.mode, step.instruction, refs[fc.path],
      { agent: `code:${skillName}`, attempt },
    );
    patches.push(patch);
  }
  return patches;
}

// ────────────────────────────────────────────────────────────
// defineSkill：工厂，凡是声明式的 skill 都用它
// ────────────────────────────────────────────────────────────

/** 单个 aspect 的追问模板（WS-4 第 1 档）。question + example 两段，缺一不可：
 *  - question: 给 PM 的自然问句
 *  - example: 至少一个具体例子，让 PM 知道答的颗粒度 */
export interface AspectTemplate {
  question: string;
  example: string;
}

export interface SkillConfig {
  name: string;
  description: string;
  matchWords: string[];
  matchThreshold?: number;        // 默认 4
  requiredWords?: string[];       // 必选词
  /** 该 skill 涉及的澄清 aspect 枚举（如 ["field-name","field-type","display-position","calculation-rule"]）。
   *  ClarifyAgent 会把所有已注册 skill 的并集喂给 LLM，让它给每个澄清问题打 aspect 标签。 */
  possibleAspects?: string[];
  /** WS-4 第 1 档：每个 possibleAspect 都必须有对应的 question/example 模板。
   *  defineSkill 在启动时校验，缺失 / 空字符串直接 throw。 */
  aspectQuestionTemplate?: Record<string, AspectTemplate>;
  buildSteps: (req: ClarifiedRequest, ctx: RepoContext) => FileStep[];
  referenceFor?: ReferenceProvider;
}

/** 运行时校验 aspect 模板。任一违规直接 throw，让 registry.loadSkills 启动失败。
 *  违规类型：
 *   - possibleAspects 非空但 aspectQuestionTemplate 缺失
 *   - possibleAspects 中某 aspect 在 template 里找不到
 *   - 该 aspect 的 question 或 example 是空字符串/纯空白
 *   - template 含未在 possibleAspects 中声明的多余 aspect（防拼写漂移）
 */
function validateAspectTemplate(cfg: SkillConfig): void {
  const aspects = cfg.possibleAspects ?? [];
  if (aspects.length === 0) return;  // 没声明 aspect → 模板可选

  const tmpl = cfg.aspectQuestionTemplate;
  if (!tmpl) {
    throw new Error(`[defineSkill:${cfg.name}] possibleAspects 非空但 aspectQuestionTemplate 缺失`);
  }

  for (const aspect of aspects) {
    const entry = tmpl[aspect];
    if (!entry) {
      throw new Error(`[defineSkill:${cfg.name}] aspectQuestionTemplate 缺少 aspect "${aspect}" 的条目`);
    }
    if (!entry.question?.trim()) {
      throw new Error(`[defineSkill:${cfg.name}] aspect "${aspect}" 的 template.question 为空`);
    }
    if (!entry.example?.trim()) {
      throw new Error(`[defineSkill:${cfg.name}] aspect "${aspect}" 的 template.example 为空（必须含至少一个具体例子）`);
    }
  }

  // 反向检查：template 多余条目（拼写错的 aspect 不会被任何代码引用，静默 bug 源头）
  const declared = new Set(aspects);
  for (const key of Object.keys(tmpl)) {
    if (!declared.has(key)) {
      throw new Error(`[defineSkill:${cfg.name}] aspectQuestionTemplate 含未声明的 aspect "${key}"（拼写错误？请加入 possibleAspects 或删除该条）`);
    }
  }
}

export function defineSkill(cfg: SkillConfig): Skill {
  validateAspectTemplate(cfg);
  const threshold = cfg.matchThreshold ?? 4;

  return {
    name: cfg.name,
    description: cfg.description,
    possibleAspects: cfg.possibleAspects ?? [],
    aspectQuestionTemplate: cfg.aspectQuestionTemplate ?? {},

    match(req) {
      return keywordMatch(req, cfg.matchWords, { threshold, requiredWords: cfg.requiredWords });
    },

    async plan(req, ctx) {
      return { skillName: cfg.name, files: cfg.buildSteps(req, ctx) };
    },

    async locate(plan, ctx) {
      return defaultLocate(plan, ctx, cfg.referenceFor);
    },

    async generate(changes, llm) {
      return defaultGenerate(changes, llm);
    },
  };
}

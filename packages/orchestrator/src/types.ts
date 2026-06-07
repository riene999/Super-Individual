// ────────────────────────────────────────────────────────────
// 核心领域类型
// ────────────────────────────────────────────────────────────

/** PM 的原始自然语言输入 */
export interface RawRequest {
  text: string;
}

/** 澄清问题 + aspect 标签，用于历史 QA 按语义匹配预填 */
export interface ClarifyingQuestion {
  q: string;
  /** 必填，可为 "other"，必须属于 skill.possibleAspects ∪ ["other"] */
  aspect: string;
}

/** ClarifyAgent 输出的结构化需求 */
export interface ClarifiedRequest {
  summary: string;
  fieldName: string;
  fieldType: "integer" | "float" | "string" | "boolean";
  displayLocation: string;
  businessRule: string;
  /** 澄清阶段追问的问题（含 aspect 标签）。空数组表示无需追问。 */
  clarifyingQuestions: ClarifyingQuestion[];
  /** PM 回答了澄清问题之后的补充上下文 */
  answers?: Record<string, string>;
}

/** 单个文件的修改/创建意图（locate→generate 的最小单位） */
export interface FileStep {
  path: string;                    // 相对于 conduit 根目录
  mode: "modify" | "create";       // 修正 3：mode 决定 locate 是否允许目标存在
  instruction: string;             // 给 LLM 的本文件改动意图
}

/** SkillPlan：某个 Skill 给出的实施方案。files 是唯一事实来源。 */
export interface SkillPlan {
  skillName: string;
  files: FileStep[];
}

/** 单个文件变更描述 */
export interface FileChange {
  path: string;        // 相对于 conduit 根目录
  reason: string;      // 为什么要改这个文件
}

/** LocateAgent 输出的变更集 */
export interface ChangeSet {
  files: FileChange[];
  context: Record<string, string>; // 文件路径 → 当前文件内容片段
  meta?: Record<string, unknown>;  // skill 自定义结构化上下文（locate → generate 透传）
}

/** CodeAgent 产出的单文件 patch */
export interface FilePatch {
  path: string;
  newContent: string; // 完整新文件内容（MVP 用整文件替换，避免 diff 解析复杂度）
}

/** Repo 操作上下文 */
export interface RepoContext {
  repoPath: string;
  branch: string;
}

// ────────────────────────────────────────────────────────────
// 事件系统
// ────────────────────────────────────────────────────────────

export type EventType =
  | "run.started"
  | "clarify.questions"
  | "clarify.done"
  | "plan.done"
  | "plan.generic"
  | "recall.matched"
  | "recall.stale"
  | "recall.dismissed"
  | "aspect.scanned"
  | "locate.done"
  | "locate.error"
  | "code.done"
  | "verify.running"
  | "verify.done"
  | "verify.failed"
  | "commit.done"
  | "run.completed"
  | "run.error"
  | "run.intervened"
  | "llm.call";

export interface RunEvent<T = unknown> {
  type: EventType;
  runId: string;
  ts: number; // Date.now()
  payload: T;
}

// ────────────────────────────────────────────────────────────
// Skill 接口（§5.1）
// ────────────────────────────────────────────────────────────

import type { LLMClient } from "./llm/doubao.js";

/** 与 SkillConfig.aspectQuestionTemplate 同结构，从 Skill 暴露给 aspectScan 阶段使用 */
export interface AspectTemplate {
  question: string;
  example: string;
}

export interface Skill {
  name: string;
  description: string;
  /** 该 skill 涉及的澄清 aspect 枚举，用于 ClarifyAgent 给问题打标 */
  possibleAspects: string[];
  /** WS-4 第 1 档：每个 possibleAspect 必须有对应的追问模板 */
  aspectQuestionTemplate: Record<string, AspectTemplate>;
  match(req: ClarifiedRequest): number;
  plan(req: ClarifiedRequest, ctx: RepoContext): Promise<SkillPlan>;
  locate(plan: SkillPlan, ctx: RepoContext): Promise<ChangeSet>;
  generate(changes: ChangeSet, llm: LLMClient): Promise<FilePatch[]>;
}

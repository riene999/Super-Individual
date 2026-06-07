// ────────────────────────────────────────────────────────────
// 业务上下文反哺：记忆与召回的核心类型
// ────────────────────────────────────────────────────────────

export type Layer = "backend" | "frontend" | "db";

export interface ExtractedEntities {
  /** Conduit 领域名词，如 article / tag / user。仅含真正涉及的对象 */
  domainObjects: string[];
  /** 业务动作短语，如 add-virtual-field / add-list-filter */
  operations: string[];
  /** 栈层。规则计算，不让 LLM 推：
   *   含 "models/" 或 "migrations" → "db"
   *   含 "backend/"               → "backend"
   *   含 "frontend/"              → "frontend" */
  affectedLayers: Layer[];
  /** 新增数据字段名，没有则 [] */
  fieldsAdded: string[];
  /** 涉及的前端组件/页面名（具体名，不要 "component" / "page"） */
  uiSurfaces: string[];
}

export interface ClarificationQA {
  q: string;
  a: string;
  /** aspect 标签。沉淀兼容性：缺失时默认 "other"，"other" 不参与精确预填，仅作参考提示。 */
  aspect?: string;
}

export interface RequestMemory {
  runId: string;
  ts: number;
  summary: string;            // 复用 ClarifiedRequest.summary，不二次生成
  skillUsed: string;
  entities: ExtractedEntities;
  changedFiles: string[];
  clarifications: ClarificationQA[];
  outcome: "verified" | "failed";
}

/** 召回打分结果 */
export interface RecallMatch {
  memory: RequestMemory;
  score: number;                // 0-1
  matchedDimensions: string[];  // 用于前端 RecallCard 直接渲染
}

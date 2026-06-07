import type { LLMClient } from "../llm/doubao.js";
import type { ExtractedEntities, ClarificationQA, Layer } from "./types.js";
import { inferLayers } from "./layers.js";

const SYSTEM = `你是代码变更结构化分析器。只输出 JSON，不加任何解释。`;

/**
 * 抽取 prompt：含正例 + **反例约束**（防 LLM 过度泛化）。
 * 反例覆盖三类典型错误：
 *   1. domainObjects 过度填充
 *   2. operations 写成宽泛词
 *   3. uiSurfaces 写通用名
 */
function buildPrompt(
  summary: string,
  skillUsed: string | null,
  changedFiles: string[] | undefined,
  clarifications: ClarificationQA[] | undefined,
): string {
  const qa = clarifications?.length
    ? clarifications.map((c) => `Q: ${c.q}\nA: ${c.a}`).join("\n")
    : "(无)";
  // 沉淀时有 changedFiles；query 时（即 plan 后尚未生成代码）没有 — 提示 LLM 基于语义推测
  const filesLine = changedFiles?.length
    ? changedFiles.join(", ")
    : "(尚未生成，基于需求语义推测)";

  return `从以下代码变更信息中抽取结构化业务实体。

输入：
- 摘要：${summary}
- Skill：${skillUsed}
- 改动文件：${filesLine}
- 澄清问答：
${qa}

输出严格 JSON（不含 affectedLayers，由代码根据路径自算）：
{
  "domainObjects": [...],   // Conduit 领域名词，仅含真正涉及的对象
  "operations": [...],      // 业务动作短语，可与 skill 名重叠
  "fieldsAdded": [...],     // 新增字段名，没有则 []
  "uiSurfaces": [...]       // 前端组件/页面具体名，没有则 []
}

正例：
摘要：在文章卡片展示阅读时长
Skill：add-field
改动：backend/models/Article.js, frontend/src/components/ArticleMeta/ArticleMeta.jsx
输出：
{"domainObjects":["article"],"operations":["add-virtual-field"],"fieldsAdded":["readingTime"],"uiSurfaces":["ArticleMeta","ArticlesPreview"]}

反例（不要这样做）：
- 仅改了 Article 模型时，domainObjects 不要写 ["article","tag","user"]，只填 ["article"]
- operations 不要返回宽泛词如 ["modify","update","change"]，要业务化短语如 "add-virtual-field" / "add-list-filter" / "add-readonly-page"
- uiSurfaces 不要写 "component" "page" 这种通用词，要具体组件名如 "ArticleMeta"
- domainObjects 不要包含动作（"filter"、"add"）

现在分析输入，输出 JSON：`;
}

interface RawExtract {
  domainObjects?: unknown;
  operations?: unknown;
  fieldsAdded?: unknown;
  uiSurfaces?: unknown;
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim());
}

function fallbackEntities(skillUsed: string | null, changedFiles?: string[]): ExtractedEntities {
  return {
    domainObjects: [],
    operations: skillUsed ? [skillUsed] : [],
    affectedLayers: inferLayers(changedFiles ?? []),
    fieldsAdded: [],
    uiSurfaces: [],
  };
}

/**
 * 调用 LLM 抽取业务实体；任何失败兜底为最小结构（不让 run 因抽取失败回滚）。
 * affectedLayers 用规则算，不依赖 LLM 输出。
 */
export async function extractEntities(
  llm: LLMClient,
  args: {
    runId: string;
    summary: string;
    skillUsed: string | null;
    /** 沉淀时必填，query 时省略 */
    changedFiles?: string[];
    /** 沉淀/query 都可有可无 */
    clarifications?: ClarificationQA[];
  },
): Promise<ExtractedEntities> {
  // changedFiles 缺失时，affectedLayers 为 [] —— 查询端 uiSurfaces 也会是 []，符合"召回靠 operations + domainObjects 主导"的约束
  const affectedLayers: Layer[] = inferLayers(args.changedFiles ?? []);

  try {
    const result = await llm.chat(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: buildPrompt(args.summary, args.skillUsed, args.changedFiles, args.clarifications) },
      ],
      { temperature: 0.1, maxTokens: 512 },
      { agent: "memory:extract", runId: args.runId },
    );

    const cleaned = result.text.replace(/^```[a-z]*\n?/m, "").replace(/```$/m, "").trim();
    const parsed = JSON.parse(cleaned) as RawExtract;

    return {
      domainObjects: toStringArray(parsed.domainObjects),
      operations:    toStringArray(parsed.operations),
      affectedLayers,
      fieldsAdded:   toStringArray(parsed.fieldsAdded),
      // query 模式（无 changedFiles）下 LLM 给的 uiSurfaces 也不可靠 — 直接强制为 []
      uiSurfaces:    args.changedFiles?.length ? toStringArray(parsed.uiSurfaces) : [],
    };
  } catch (err) {
    console.warn(`[memory:extract] 抽取失败，使用兜底：${(err as Error).message}`);
    return fallbackEntities(args.skillUsed, args.changedFiles ?? []);
  }
}

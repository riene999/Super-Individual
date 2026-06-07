import type { LLMClient } from "../llm/doubao.js";
import type { ClarifiedRequest, ClarifyingQuestion, Skill } from "../types.js";
import type { AspectScanResult, AspectScanItem } from "./aspect-scan.js";

const ANALYZE_SYSTEM = `你是代码助手，只输出 JSON，不输出任何解释。`;

const RESOLVE_SYSTEM = `你是一个产品需求分析专家。
根据 PM 原始需求 + 澄清问答，输出最终结构化 JSON。

输出格式（严格 JSON，不加 markdown）：
{
  "summary": "一句话需求摘要",
  "fieldName": "camelCase 字段名",
  "fieldType": "integer|float|string|boolean",
  "displayLocation": "展示位置描述",
  "businessRule": "计算/展示规则说明",
  "clarifyingQuestions": []
}`;

const POLISH_SYSTEM = `你是文案打磨助手。把若干机械的追问句改写得更自然、更连贯，但保留所有"例如"示例与字段含义。只输出 JSON 数组。`;

function parseJson(text: string): Record<string, unknown> {
  const cleaned = text.replace(/^```[a-z]*\n?/m, "").replace(/```$/m, "").trim();
  return JSON.parse(cleaned);
}

export interface ClarifyAnalysis {
  req: ClarifiedRequest;
  /** WS-4：questions 由后续 buildQuestionsFromAspects 生成，不再由 analyze 产出 */
  questions: ClarifyingQuestion[];
}

export const clarifyAgent = {
  /**
   * WS-4 重构：analyze 只解析语义（summary / fieldName / ...），不再生成 clarifyingQuestions。
   * questions 由后续 aspectScan + buildQuestionsFromAspects 接管。
   */
  async analyze(rawText: string, llm: LLMClient): Promise<ClarifyAnalysis> {
    const result = await llm.chat([
      { role: "system", content: ANALYZE_SYSTEM },
      {
        role: "user",
        content: `将下面的 PM 需求解析成 JSON：
- summary: 一句话摘要
- fieldName: camelCase 字段名（如 readingTime；若需求未涉及具体字段则给 "n/a"）
- fieldType: integer|float|string|boolean（无关时填 string）
- displayLocation: 展示位置（PM 未提则用合理推测，如"文章卡片 ArticleMeta 组件，日期旁边"）
- businessRule: 计算/展示规则（PM 未提则给合理推测）

**重要**：不要在输出里包含 clarifyingQuestions 字段或任何问题，那由其他模块生成。

示例：
输入："我想在每篇文章卡片上看到大概要读几分钟"
输出：{"summary":"文章卡片展示预计阅读时长","fieldName":"readingTime","fieldType":"integer","displayLocation":"文章卡片 ArticleMeta 组件，日期旁边","businessRule":"正文字数/200 向上取整，单位分钟，最少1分钟"}

现在解析：
输入："${rawText}"
输出：`,
      },
    ], undefined, { agent: "clarify:analyze" });

    const data = parseJson(result.text);
    const req: ClarifiedRequest = {
      summary: String(data.summary ?? ""),
      fieldName: String(data.fieldName ?? ""),
      fieldType: (data.fieldType as ClarifiedRequest["fieldType"]) ?? "string",
      displayLocation: String(data.displayLocation ?? ""),
      businessRule: String(data.businessRule ?? ""),
      clarifyingQuestions: [],   // 由后续 buildQuestionsFromAspects 填
    };

    return { req, questions: [] };
  },

  async resolve(
    rawText: string,
    partial: ClarifiedRequest,
    answers: Record<string, string>,
    llm: LLMClient
  ): Promise<ClarifiedRequest> {
    const qa = Object.entries(answers)
      .map(([q, a]) => `Q: ${q}\nA: ${a}`)
      .join("\n\n");

    const result = await llm.chat([
      { role: "system", content: RESOLVE_SYSTEM },
      {
        role: "user",
        content: `原始需求：${rawText}\n\n初步解析：${JSON.stringify(partial, null, 2)}\n\n澄清问答：\n${qa}`,
      },
    ], undefined, { agent: "clarify:resolve" });

    const data = parseJson(result.text);
    return {
      summary: String(data.summary ?? partial.summary),
      fieldName: String(data.fieldName ?? partial.fieldName),
      fieldType: (data.fieldType as ClarifiedRequest["fieldType"]) ?? partial.fieldType,
      displayLocation: String(data.displayLocation ?? partial.displayLocation),
      businessRule: String(data.businessRule ?? partial.businessRule),
      clarifyingQuestions: [],
      answers,
    };
  },

  async genericQuestions(
    rawText: string,
    partial: ClarifiedRequest,
    llm: LLMClient,
    runId: string,
  ): Promise<ClarifyingQuestion[]> {
    try {
      const result = await llm.chat([
        {
          role: "system",
          content: "你是产品需求澄清助手。只输出严格 JSON，不要输出解释。",
        },
        {
          role: "user",
          content: `判断下面的需求在进入代码修改前是否还有必须澄清的地方。

原始需求：${rawText}

当前结构化理解：
${JSON.stringify(partial, null, 2)}

输出格式：{"questions":["问题1","问题2"]}

要求：
- 返回 0 到 3 个问题。
- 只问真正会影响代码修改安全性的问题。
- 如果需求已经清楚，返回 {"questions":[]}。`,
        },
      ], { temperature: 0.1, maxTokens: 512 }, { agent: "clarify:generic", runId });

      const data = parseJson(result.text) as { questions?: unknown };
      if (!Array.isArray(data.questions)) return [];
      return data.questions
        .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
        .slice(0, 3)
        .map((q) => ({ q: q.trim(), aspect: "other" }));
    } catch (err) {
      console.warn(`[clarify:generic] 生成澄清问题失败，按无需追问继续：${(err as Error).message}`);
      return [];
    }
  },
};

// ────────────────────────────────────────────────────────────
// WS-4 新增：从 aspectScan 结果 + skill 模板构造问题
// ────────────────────────────────────────────────────────────

/** 把模板的 question + example 拼成一句完整提问 */
function templateToQuestion(skill: Skill, aspect: string): string | null {
  const tmpl = skill.aspectQuestionTemplate[aspect];
  if (!tmpl) return null;   // 不应该发生（defineSkill 已校验），但保守处理
  return `${tmpl.question}（${tmpl.example}）`;
}

/**
 * 步骤 B：仅对 status === "needs-asking" 的 aspect 生成问题。
 *   - 0 或 1 个：直接出模板，零 LLM
 *   - ≥ 2 个：起一次 LLM 打磨措辞（保留 example、不改语义）
 */
export async function buildQuestionsFromAspects(
  scanItems: AspectScanItem[],
  skill: Skill,
  llm: LLMClient,
  runId: string,
): Promise<ClarifyingQuestion[]> {
  // 过滤到属于当前 skill 的 aspect 且 status === needs-asking
  const skillAspects = new Set(skill.possibleAspects);
  const askable = scanItems.filter((s) => skillAspects.has(s.aspect) && s.status === "needs-asking");
  if (askable.length === 0) return [];

  // 模板拼基础问题（永远可用兜底）
  const base = askable.map((s) => {
    const tmpl = templateToQuestion(skill, s.aspect);
    return tmpl ? { q: tmpl, aspect: s.aspect } : null;
  }).filter((x): x is ClarifyingQuestion => x !== null);

  if (base.length <= 1) return base;   // 0/1 个不打磨

  // ≥ 2 个：LLM 打磨措辞，保留 example
  try {
    const result = await llm.chat([
      { role: "system", content: POLISH_SYSTEM },
      {
        role: "user",
        content: `把以下追问句改写得更自然连贯，但**严格保留**括号内"例如"示例与字段含义。输出与输入等长 JSON 数组，元素为 {"q": "改写后的问句", "aspect": "原 aspect"}。

输入：
${JSON.stringify(base, null, 2)}

输出：`,
      },
    ], undefined, { agent: "clarify:polish", runId });

    const cleaned = result.text.replace(/^```[a-z]*\n?/m, "").replace(/```$/m, "").trim();
    const polished = JSON.parse(cleaned) as Array<{ q?: string; aspect?: string }>;
    if (!Array.isArray(polished) || polished.length !== base.length) {
      console.warn(`[clarify:polish] LLM 输出长度不匹配 (${polished?.length ?? "?"} vs ${base.length})，回退到模板`);
      return base;
    }

    // 校验：每条都有 q + aspect，且 aspect 与原 base 顺序一致（防 LLM 错排）
    const out: ClarifyingQuestion[] = [];
    for (let i = 0; i < base.length; i++) {
      const p = polished[i];
      const q = typeof p?.q === "string" && p.q.trim() ? p.q.trim() : base[i].q;
      out.push({ q, aspect: base[i].aspect });   // aspect 永远用 base 的，不信 LLM
    }
    return out;
  } catch (err) {
    console.warn(`[clarify:polish] 失败，回退模板：${(err as Error).message}`);
    return base;
  }
}

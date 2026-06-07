/**
 * WS-4 第 2 档：aspectScan — 判断每个候选 aspect 在 PM 输入或历史召回中的状态。
 *
 * 设计要点（加固对照）：
 *   - 加固 1：confidence < 0.7 的 explicit / from-history 降级为 needs-asking
 *             （但 evidence 保留，由下游做"预填提示"用）
 *   - 加固 2：调用方只传 score ≥ 0.5 的 top-2 召回，prompt 不塞全量历史
 *   - 失败兜底：JSON 解析 / LLM 异常 → 全部 needs-asking（保守，确保不会"跳过没问清楚"的 aspect）
 *
 * 不依赖 ClarifyAgent；第 3 档接入时由 orchestrator 在 clarify 步 A 调用。
 */
import type { LLMClient } from "../llm/doubao.js";

export type AspectStatus = "explicit" | "from-history" | "needs-asking";

export interface AspectScanItem {
  aspect: string;
  status: AspectStatus;
  /** 0-1：< 0.7 时 explicit/from-history 会被降级 */
  confidence: number;
  /** explicit: PM 输入里的具体词句；from-history: 历史答案 */
  evidence?: string;
  /** 降级前的原始 status（仅在降级后存在），用于审计/事件流可追溯 */
  rawStatus?: AspectStatus;
}

export interface RecalledForScan {
  runId: string;
  score: number;
  summary: string;
  clarifications: Array<{ q: string; a: string; aspect?: string }>;
}

export interface AspectScanInput {
  runId: string;
  rawText: string;
  /** 所有已注册 skill 的 possibleAspects 并集（去重） */
  candidateAspects: string[];
  /** 已由调用方预过滤为 score ≥ 0.5 的 top-2 */
  recalledHistory: RecalledForScan[];
}

export interface AspectScanResult {
  items: AspectScanItem[];
}

const CONFIDENCE_THRESHOLD = 0.7;

const SYSTEM = `你是需求清晰度分析器。只输出 JSON，不加任何解释。`;

function buildPrompt(input: AspectScanInput): string {
  const histBlock = input.recalledHistory.length === 0
    ? "(无相似历史 run)"
    : input.recalledHistory.map((h, i) => {
        const qaList = h.clarifications.length
          ? h.clarifications.map((c) => `    - [${c.aspect ?? "other"}] Q: ${c.q}  A: ${c.a}`).join("\n")
          : "    (无澄清问答)";
        return `历史 ${i + 1}: run #${h.runId.slice(0, 8)} (score ${h.score.toFixed(2)})
  摘要: ${h.summary}
  澄清问答:
${qaList}`;
      }).join("\n\n");

  return `判断每个候选 aspect 在 PM 输入或历史召回中是否已表达。

PM 当前输入：
"${input.rawText}"

候选 aspect 列表（共 ${input.candidateAspects.length} 个）：
${input.candidateAspects.map((a) => `  - ${a}`).join("\n")}

${histBlock}

对每个候选 aspect 输出一项，status 三选一：
  - explicit:     PM 输入里明确表达了该 aspect 的具体值
  - from-history: PM 输入未提，但某条历史的同 aspect 答案直接适用
  - needs-asking: 上述都不满足

规则（必须遵守）：
  1. evidence 必须引用具体词句，不能写"PM 提到了 X"这种泛泛之言
  2. from-history 仅当历史 clarification 的 aspect 与候选 aspect **完全相同**才可使用；不要跨 aspect 硬套
  3. 不确定时降低 confidence（< 0.7 会被降级为 needs-asking）
  4. 仅返回候选列表中的 aspect，**不要发明新 aspect**
  5. 仅返回 candidateAspects 里的项，**不重复、不遗漏**

输出严格 JSON：
{
  "items": [
    {"aspect": "field-name", "status": "explicit", "evidence": "PM 说'readingTime 字段'", "confidence": 0.95},
    {"aspect": "field-type", "status": "from-history", "evidence": "历史 1 答 'VIRTUAL'", "confidence": 0.85},
    {"aspect": "display-position", "status": "needs-asking", "confidence": 1.0}
  ]
}

现在输出：`;
}

function fallback(candidateAspects: string[]): AspectScanResult {
  return {
    items: candidateAspects.map((a) => ({ aspect: a, status: "needs-asking" as AspectStatus, confidence: 0 })),
  };
}

/** 解析 LLM 输出，过滤非法 aspect / 补全缺失 aspect / 应用降级规则 */
function parseAndNormalize(raw: string, candidateAspects: string[]): AspectScanResult {
  const cleaned = raw.replace(/^```[a-z]*\n?/m, "").replace(/```$/m, "").trim();
  const data = JSON.parse(cleaned) as { items?: Array<{ aspect?: string; status?: string; evidence?: string; confidence?: number }> };
  const rawItems = Array.isArray(data.items) ? data.items : [];

  const validAspects = new Set(candidateAspects);
  const seen = new Set<string>();
  const out: AspectScanItem[] = [];

  for (const r of rawItems) {
    if (typeof r?.aspect !== "string" || !validAspects.has(r.aspect) || seen.has(r.aspect)) continue;
    seen.add(r.aspect);

    const rawStatus: AspectStatus =
      r.status === "explicit" || r.status === "from-history" ? r.status : "needs-asking";
    const confidence = typeof r.confidence === "number" ? Math.max(0, Math.min(1, r.confidence)) : 0.5;
    const evidence = typeof r.evidence === "string" && r.evidence.trim() ? r.evidence.trim() : undefined;

    // 降级规则：confidence < 0.7 的 explicit/from-history → needs-asking（evidence 保留）
    const needsDowngrade = (rawStatus === "explicit" || rawStatus === "from-history") && confidence < CONFIDENCE_THRESHOLD;
    out.push({
      aspect: r.aspect,
      status: needsDowngrade ? "needs-asking" : rawStatus,
      confidence,
      evidence,
      rawStatus: needsDowngrade ? rawStatus : undefined,
    });
  }

  // 补全 LLM 漏掉的 aspect（按"未明"处理）
  for (const a of candidateAspects) {
    if (!seen.has(a)) out.push({ aspect: a, status: "needs-asking", confidence: 0 });
  }

  // 输出顺序与 candidateAspects 一致，便于断言稳定
  const byAspect = new Map(out.map((it) => [it.aspect, it]));
  return { items: candidateAspects.map((a) => byAspect.get(a)!) };
}

export async function aspectScan(llm: LLMClient, input: AspectScanInput): Promise<AspectScanResult> {
  if (input.candidateAspects.length === 0) return { items: [] };

  try {
    const result = await llm.chat(
      [{ role: "system", content: SYSTEM }, { role: "user", content: buildPrompt(input) }],
      { temperature: 0.1, maxTokens: 1024 },
      { agent: "clarify:aspect-scan", runId: input.runId },
    );
    return parseAndNormalize(result.text, input.candidateAspects);
  } catch (err) {
    console.warn(`[aspect-scan] LLM 失败，全部 needs-asking 兜底: ${(err as Error).message}`);
    return fallback(input.candidateAspects);
  }
}

// ────────────────────────────────────────────────────────────
// 辅助：从 recall.matched payload 过滤 top-2 (score ≥ 0.5)
// ────────────────────────────────────────────────────────────

/** 加固 2 的预过滤工具：调用方传 recall.matched.payload.matches，得到喂给 aspectScan 的精简历史 */
export function filterRecallForScan(
  matches: Array<{ runId: string; score: number; summary?: string; outcome?: string; clarifications?: Array<{ q?: string; a?: string; aspect?: string }> }>,
  opts: { minScore?: number; topK?: number } = {},
): RecalledForScan[] {
  const minScore = opts.minScore ?? 0.5;
  const topK = opts.topK ?? 2;
  return matches
    .filter((m) => m.score >= minScore && m.outcome !== "failed")  // failed 历史不参与 from-history 候选
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((m) => ({
      runId: m.runId,
      score: m.score,
      summary: m.summary ?? "",
      clarifications: (m.clarifications ?? []).map((c) => ({
        q: c.q ?? "",
        a: c.a ?? "",
        aspect: c.aspect,
      })),
    }));
}

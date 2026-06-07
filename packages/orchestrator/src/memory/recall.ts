import type { ExtractedEntities, RequestMemory, RecallMatch } from "./types.js";

function intersect<T>(a: T[], b: T[]): T[] {
  const set = new Set(b);
  return a.filter((x) => set.has(x));
}

function jaccard<T>(a: T[], b: T[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const inter = intersect(a, b).length;
  const uni = new Set([...a, ...b]).size;
  return uni === 0 ? 0 : inter / uni;
}

/**
 * 召回打分：权重 0.40 / 0.30·jaccard / 0.20 / 0.10。
 * failed run 召回时整体降权 0.5×（微调 1）。
 */
export function score(query: ExtractedEntities, candidate: RequestMemory): RecallMatch {
  const a = query;
  const b = candidate.entities;
  const matchedDimensions: string[] = [];
  let s = 0;

  // 操作类型 — 高权重 (0.40)
  if (intersect(a.operations, b.operations).length > 0) {
    s += 0.40;
    matchedDimensions.push("同样的操作类型");
  }

  // 领域对象 — 中权重 (0.30 · jaccard)
  const objJac = jaccard(a.domainObjects, b.domainObjects);
  if (objJac > 0) {
    s += 0.30 * objJac;
    const overlap = intersect(a.domainObjects, b.domainObjects);
    matchedDimensions.push(`涉及相同对象: ${overlap.join(", ")}`);
  }

  // UI 组件 — 高权重 (0.20)
  const uiOverlap = intersect(a.uiSurfaces, b.uiSurfaces);
  if (uiOverlap.length > 0) {
    s += 0.20;
    matchedDimensions.push(`涉及相同组件: ${uiOverlap.join(", ")}`);
  }

  // 栈层 — 低权重 (0.10)
  if (intersect(a.affectedLayers, b.affectedLayers).length > 0) {
    s += 0.10;
  }

  // 微调 1：failed run 整体降权
  if (candidate.outcome === "failed") s *= 0.5;

  return { memory: candidate, score: Math.min(s, 1.0), matchedDimensions };
}

/** 对 query 在所有候选 memories 里做召回，按分数降序返回 topK 中超过阈值的条目 */
export function recall(
  query: ExtractedEntities,
  memories: RequestMemory[],
  opts: { topK?: number; minScore?: number } = {},
): RecallMatch[] {
  const { topK = 3, minScore = 0.3 } = opts;
  return memories
    .map((m) => score(query, m))
    .filter((m) => m.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

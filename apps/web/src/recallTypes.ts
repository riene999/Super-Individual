export interface RecallQA {
  q: string;
  a: string;
  aspect?: string;
}

export interface RecallMatchView {
  runId: string;
  score: number;
  matchedDimensions: string[];
  summary: string;
  skillUsed: string;
  outcome: "verified" | "failed";
  expectedFiles: string[];
  clarifications: RecallQA[];
}

export interface ClarifyingQ {
  q: string;
  aspect: string;
}

/** PrefilledInput 的渲染状态：三种之一（修正 1） */
export type PrefillState =
  | { mode: "empty" }
  | { mode: "exact"; value: string; sourceLabel: string; sourceRunId: string }
  | { mode: "hint";  hint: string; sourceRunId: string };

/** 把"主因（operations）"与"次因（domain/ui）"分组。affectedLayers(0.1) 不展示。 */
export function splitDimensions(dims: string[]): { primary: string[]; secondary: string[] } {
  const primary: string[] = [];
  const secondary: string[] = [];
  for (const d of dims) {
    if (d.includes("同样的操作")) primary.push(d);
    else if (d.startsWith("涉及相同")) secondary.push(d);
    // 栈层等其它维度不展示
  }
  return { primary, secondary };
}

/** 对每个新问题在召回历史里找 aspect 匹配，返回三态之一。 */
export function computePrefill(
  q: ClarifyingQ,
  matches: RecallMatchView[],
  dismissedRunIds: Set<string>,
): PrefillState {
  const active = matches.filter((m) => !dismissedRunIds.has(m.runId));
  if (active.length === 0) return { mode: "empty" };

  // 状态 2：aspect 完全匹配（且不为 "other"，"other" 不参与精确预填）
  if (q.aspect !== "other") {
    for (const m of active) {
      const hit = m.clarifications.find((c) => (c.aspect ?? "other") === q.aspect);
      if (hit) return { mode: "exact", value: hit.a, sourceLabel: `上次答的`, sourceRunId: m.runId };
    }
  }

  // 状态 3：aspect 不匹配但有召回 → 取 top-1 的第一条 QA 作为提示
  const top = active[0];
  if (top.clarifications.length > 0) {
    const hint = top.clarifications[0].a;
    return { mode: "hint", hint: `上次类似问题答过：${hint}`, sourceRunId: top.runId };
  }
  return { mode: "empty" };
}

import type { RunEvent } from "./types.js";

const LABELS: Record<string, string> = {
  "run.started":       "🚀 Run Started",
  "clarify.questions": "❓ Clarify",
  "clarify.done":      "✅ Clarify Done",
  "plan.done":         "📋 Plan",
  "recall.matched":    "🧠 Recall · matched",
  "recall.stale":      "⚠ Recall · stale",
  "recall.dismissed":  "⚪ Recall · dismissed",
  "aspect.scanned":    "🧭 Aspect Scan",
  "locate.done":       "🔍 Locate",
  "locate.error":      "🚫 Locate Error",
  "code.done":         "⚙️  Code",
  "verify.running":    "🧪 Verify…",
  "verify.done":       "✅ Verify Passed",
  "verify.failed":     "❌ Verify Failed",
  "commit.done":       "🎉 Commit",
  "run.completed":     "✔  Completed",
  "run.error":         "💥 Error",
  "run.intervened":    "↩  Replayed",
  "llm.call":          "🔹 LLM Call",
};

function fmtPayload(type: string, payload: Record<string, unknown>): string {
  if (type === "clarify.questions") {
    const qs = (payload.questions as string[]) ?? [];
    if (!qs.length) return "No questions — request is clear.";
    return qs.map((q, i) => `${i + 1}. ${q}`).join("\n");
  }
  if (type === "clarify.done") {
    const r = payload.req as Record<string, unknown> | undefined;
    if (!r) return "";
    return `Field: ${r.fieldName}  (${r.fieldType})\nRule:  ${r.businessRule}\nWhere: ${r.displayLocation}`;
  }
  if (type === "plan.done") {
    const p = payload.plan as Record<string, unknown> | undefined;
    const files = (p?.files as Array<{ path: string; mode: string; instruction: string }>) ?? [];
    const by = String(payload.by ?? "keyword");
    const candidates = (payload.candidates as Array<{ name: string; score: number }>) ?? [];
    const reason = payload.routerReason ? `\n  ↳ LLM 理由: ${payload.routerReason}` : "";
    const scoreBoard = candidates.length
      ? "\n候选评分: " + candidates.map((c) => `${c.name}=${c.score.toFixed(2)}`).join("  ")
      : "";
    return `Skill: ${payload.skillName}  score=${Number(payload.score).toFixed(2)}  by=${by}${reason}${scoreBoard}\n` +
           files.map((f, i) => `${i + 1}. [${f.mode}] ${f.path}\n   ${f.instruction}`).join("\n");
  }
  if (type === "locate.done") {
    const attempt = Number(payload.attempt ?? 1);
    const attemptTag = attempt > 1 ? `attempt #${attempt} (post-recall fallback)\n` : "";
    const files = (payload.files as Array<{path:string}>) ?? [];
    return attemptTag + files.map(f => `• ${f.path}`).join("\n");
  }
  if (type === "recall.matched") {
    const matches = (payload.matches as Array<{ runId: string; score: number; matchedDimensions: string[]; summary: string; skillUsed: string; outcome: string; expectedFiles: string[] }>) ?? [];
    if (!matches.length) return "No matches above threshold.";
    return `${matches.length} historical run(s) matched:\n` + matches.map((m) => {
      const head = `▸ run #${m.runId.slice(0, 4)}  score=${m.score.toFixed(2)}  ${m.outcome === "failed" ? "⚠ failed" : "✓"}`;
      const dims = m.matchedDimensions.length ? `  matched: ${m.matchedDimensions.join(" / ")}` : "";
      const files = m.expectedFiles.length ? `  expected files:\n    ${m.expectedFiles.slice(0, 4).join("\n    ")}` : "";
      return `${head}\n${dims}\n${files}`;
    }).join("\n\n");
  }
  if (type === "aspect.scanned") {
    const skill = String(payload.skillName ?? "?");
    const forSkill = (payload.forSkill as Array<{ aspect: string; status: string; confidence: number; evidence?: string; rawStatus?: string }>) ?? [];
    const bd = payload.breakdown as { explicit: number; fromHistory: number; needsAsking: number };
    const head = `skill: ${skill}  ·  explicit=${bd.explicit}  from-history=${bd.fromHistory}  needs-asking=${bd.needsAsking}`;
    const lines = forSkill.map((s) => {
      const flag = s.status === "explicit" ? "✓" : s.status === "from-history" ? "↺" : "?";
      const conf = `(c=${s.confidence.toFixed(2)})`;
      const down = s.rawStatus ? ` [降级 from ${s.rawStatus}]` : "";
      const ev = s.evidence ? `\n     ${s.evidence}` : "";
      return `  ${flag} [${s.status}] ${s.aspect} ${conf}${down}${ev}`;
    });
    return `${head}\n${lines.join("\n")}`;
  }
  if (type === "recall.dismissed") {
    return `historicalRunId: ${String(payload.historicalRunId).slice(0, 8)}…  (PM 主动忽略，前端预填撤回)`;
  }
  if (type === "recall.stale") {
    const stale = (payload.stale as string[]) ?? [];
    const valid = (payload.valid as string[]) ?? [];
    return `historical run #${String(payload.historicalRunId).slice(0, 4)}: ${stale.length} stale, ${valid.length} valid\n` +
           stale.map((p) => `  ✗ ${p}`).join("\n") +
           `\n→ falling back to no-recall locate (attempt #2)`;
  }
  if (type === "code.done") {
    const files = (payload.files as string[]) ?? [];
    return `Attempt #${payload.attempt}\n` + files.map(f => `• ${f}`).join("\n");
  }
  if (type === "commit.done") {
    return `Branch: ${payload.branch}\n\n${payload.prDescription}`;
  }
  if (type === "verify.failed") {
    return `Exit ${payload.exitCode}\n${String(payload.stderr ?? "").slice(0, 400)}`;
  }
  if (type === "locate.error") return `${payload.reason}\nPath: ${payload.path}\n${payload.message ?? ""}`;
  if (type === "run.error") return String(payload.message ?? "");
  if (type === "llm.call") {
    const att = Number(payload.attempt ?? 1);
    const attTag = att > 1 ? ` #${att}` : "";
    const latMs = Number(payload.latencyMs);
    const latStr = latMs >= 10000 ? `${(latMs / 1000).toFixed(1)}s` : `${Math.round(latMs)}ms`;
    return `${payload.agent}${attTag}  ${payload.promptTokens}+${payload.completionTokens} tok  ${latStr}  ¥${Number(payload.costCNY).toFixed(4)}`;
  }
  return Object.keys(payload).length ? JSON.stringify(payload, null, 2) : "";
}

export default function EventCard({ event, index }: { event: RunEvent; index: number }) {
  const label = LABELS[event.type] ?? event.type;
  const body  = fmtPayload(event.type, event.payload);
  const ts    = new Date(event.ts).toLocaleTimeString();
  const cls   = `event-card ev-${event.type.replace(/\./g, "\\.")}`;

  return (
    <div className={cls} data-index={index}>
      <div className="ev-type">
        <span className="ev-ts">{ts}</span>
        {label}
      </div>
      {body && <pre>{body}</pre>}
    </div>
  );
}

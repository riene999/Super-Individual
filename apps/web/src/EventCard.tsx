import type { RunEvent } from "./types.js";

interface EventStyle {
  title: string;
  icon: string;
  tone: "purple" | "gray" | "warn" | "recall" | "success" | "danger";
}

const EVENT_STYLES: Record<string, EventStyle> = {
  "run.started":       { title: "Run started", icon: "ti-player-play", tone: "purple" },
  "clarify.questions": { title: "Clarify questions", icon: "ti-help", tone: "gray" },
  "clarify.done":      { title: "Clarify done", icon: "ti-check", tone: "success" },
  "plan.done":         { title: "Plan matched", icon: "ti-list-check", tone: "gray" },
  "recall.stale":      { title: "Recall stale", icon: "ti-alert-triangle", tone: "warn" },
  "recall.dismissed":  { title: "Recall dismissed", icon: "ti-history-off", tone: "gray" },
  "aspect.scanned":    { title: "Aspect scanned", icon: "ti-search", tone: "purple" },
  "locate.done":       { title: "Locate done", icon: "ti-folder-search", tone: "gray" },
  "locate.error":      { title: "Locate error", icon: "ti-alert-circle", tone: "danger" },
  "code.done":         { title: "Code generated", icon: "ti-code", tone: "purple" },
  "verify.running":    { title: "Verify running", icon: "ti-shield", tone: "warn" },
  "verify.done":       { title: "Verify passed", icon: "ti-shield-check", tone: "success" },
  "verify.failed":     { title: "Verify failed", icon: "ti-shield-x", tone: "danger" },
  "commit.done":       { title: "Commit created", icon: "ti-git-commit", tone: "success" },
  "run.completed":     { title: "Run completed", icon: "ti-circle-check", tone: "success" },
  "run.error":         { title: "Run error", icon: "ti-circle-x", tone: "danger" },
  "run.intervened":    { title: "Replayed", icon: "ti-rewind", tone: "warn" },
  "llm.call":          { title: "LLM call", icon: "ti-robot", tone: "gray" },
};

function fmtCost(v: unknown): string {
  return `¥${Number(v ?? 0).toFixed(4)}`;
}

function fmtMs(v: unknown): string {
  const ms = Number(v ?? 0);
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function fmtPayload(type: string, payload: Record<string, unknown>): string {
  if (type === "clarify.questions") {
    const raw = (payload.questions as Array<string | { q: string }>) ?? [];
    const qs = raw.map((item) => (typeof item === "string" ? item : item.q));
    if (!qs.length) return "No questions. Request is clear.";
    return qs.map((q, i) => `${i + 1}. ${q}`).join("\n");
  }
  if (type === "clarify.done") {
    const r = payload.req as Record<string, unknown> | undefined;
    if (!r) return "";
    return `Field: ${r.fieldName} (${r.fieldType})\nRule: ${r.businessRule}\nWhere: ${r.displayLocation}`;
  }
  if (type === "plan.done") {
    const p = payload.plan as Record<string, unknown> | undefined;
    const files = (p?.files as Array<{ path: string; mode: string; instruction: string }>) ?? [];
    const by = String(payload.by ?? "keyword");
    const candidates = (payload.candidates as Array<{ name: string; score: number }>) ?? [];
    const reason = payload.routerReason ? `\nLLM reason: ${payload.routerReason}` : "";
    const scoreBoard = candidates.length
      ? `\nCandidates: ${candidates.map((c) => `${c.name}=${c.score.toFixed(2)}`).join("  ")}`
      : "";
    return `Skill: ${payload.skillName} · score ${Number(payload.score ?? 0).toFixed(2)} · by ${by}${reason}${scoreBoard}\n` +
      files.map((f, i) => `${i + 1}. [${f.mode}] ${f.path}\n   ${f.instruction}`).join("\n");
  }
  if (type === "locate.done") {
    const attempt = Number(payload.attempt ?? 1);
    const attemptTag = attempt > 1 ? `attempt #${attempt} · post-recall fallback\n` : "";
    const files = (payload.files as Array<{ path: string }>) ?? [];
    return attemptTag + files.map((f) => `- ${f.path}`).join("\n");
  }
  if (type === "aspect.scanned") {
    const skill = String(payload.skillName ?? "?");
    const forSkill = (payload.forSkill as Array<{ aspect: string; status: string; confidence: number; evidence?: string; rawStatus?: string }>) ?? [];
    const bd = payload.breakdown as { explicit: number; fromHistory: number; needsAsking: number };
    const head = `skill: ${skill} · explicit ${bd.explicit} · from-history ${bd.fromHistory} · needs-asking ${bd.needsAsking}`;
    const lines = forSkill.map((s) => {
      const conf = `(c=${s.confidence.toFixed(2)})`;
      const down = s.rawStatus ? ` [downgraded from ${s.rawStatus}]` : "";
      const ev = s.evidence ? `\n   ${s.evidence}` : "";
      return `- [${s.status}] ${s.aspect} ${conf}${down}${ev}`;
    });
    return `${head}\n${lines.join("\n")}`;
  }
  if (type === "recall.dismissed") {
    return `historicalRunId: ${String(payload.historicalRunId).slice(0, 8)}... · PM ignored this history`;
  }
  if (type === "recall.stale") {
    const stale = (payload.stale as string[]) ?? [];
    const valid = (payload.valid as string[]) ?? [];
    return `historical run #${String(payload.historicalRunId).slice(0, 4)}: ${stale.length} stale, ${valid.length} valid\n` +
      stale.map((p) => `- ${p}`).join("\n") +
      `\nfallback to no-recall locate · attempt #2`;
  }
  if (type === "code.done") {
    const files = (payload.files as string[]) ?? [];
    return `Attempt #${payload.attempt}\n` + files.map((f) => `- ${f}`).join("\n");
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
    return `${payload.agent}${attTag} · ${payload.promptTokens}+${payload.completionTokens} tok · ${fmtMs(payload.latencyMs)} · ${fmtCost(payload.costCNY)}`;
  }
  return Object.keys(payload).length ? JSON.stringify(payload, null, 2) : "";
}

function eventMeta(type: string, event: RunEvent): string {
  if (type === "plan.done") return `by ${String(event.payload.by ?? "keyword")}`;
  if (type === "recall.stale") {
    const stale = ((event.payload.stale as string[]) ?? []).length;
    const valid = ((event.payload.valid as string[]) ?? []).length;
    return `${stale} stale · ${valid} valid`;
  }
  if (type === "llm.call") return fmtCost(event.payload.costCNY);
  return new Date(event.ts).toLocaleTimeString();
}

export default function EventCard({ event, index }: { event: RunEvent; index: number }) {
  const style = EVENT_STYLES[event.type] ?? { title: event.type, icon: "ti-circle", tone: "gray" as const };
  const body = fmtPayload(event.type, event.payload);

  return (
    <div className={`event ev-${event.type.replace(/\./g, "-")}`} data-index={index}>
      <div className={`event-icon ${style.tone}`}><i className={`ti ${style.icon}`} aria-hidden="true" /></div>
      <div className="event-body">
        <div className="event-head">
          <span className="event-title">{style.title}</span>
          <span className="event-meta">{eventMeta(event.type, event)}</span>
        </div>
        {body && <pre className="event-desc">{body}</pre>}
      </div>
    </div>
  );
}

import { useState, useRef, useCallback } from "react";
import type { RunEvent } from "./types.js";
import type { ClarifyingQ, RecallMatchView } from "./recallTypes.js";

const API = "/api";

export interface RunState {
  runId: string | null;
  events: RunEvent[];
  phase: string;
  waitingForAnswers: boolean;
  /** ClarifyAgent 给的问题（含 aspect） */
  clarifyQuestions: ClarifyingQ[];
  /** recall.matched 事件带来的历史候选；若 recall 未触发则为 [] */
  recallMatches: RecallMatchView[];
  /** recall.matched 是否已收到（用于 ClarifyBox 渲染时机判定） */
  recallSettled: boolean;
  /** PM 主动忽略的历史 runId 集合 */
  dismissedRunIds: Set<string>;
  done: boolean;
  error: string | null;
}

const initial: RunState = {
  runId: null,
  events: [],
  phase: "idle",
  waitingForAnswers: false,
  clarifyQuestions: [],
  recallMatches: [],
  recallSettled: false,
  dismissedRunIds: new Set(),
  done: false,
  error: null,
};

export function useRun() {
  const [state, setState] = useState<RunState>(initial);
  const esRef = useRef<EventSource | null>(null);

  const appendEvent = useCallback((ev: RunEvent) => {
    setState((prev) => {
      const events = [...prev.events, ev];
      const patch: Partial<RunState> = { events };

      if (ev.type === "clarify.questions") {
        const raw = (ev.payload.questions as Array<string | ClarifyingQ>) ?? [];
        const qs: ClarifyingQ[] = raw.map((r) =>
          typeof r === "string" ? { q: r, aspect: "other" } : { q: r.q, aspect: r.aspect ?? "other" },
        );
        patch.waitingForAnswers = qs.length > 0;
        patch.clarifyQuestions = qs;
        patch.phase = "clarify";
        // WS-4：clarify.questions 出现时，所有上游事件（recall.matched / plan.done / aspect.scanned）都已发完
        patch.recallSettled = true;
      }
      if (ev.type === "recall.matched") {
        patch.recallMatches = (ev.payload.matches as RecallMatchView[]) ?? [];
        patch.recallSettled = true;
      }
      if (ev.type === "plan.done" || ev.type === "plan.generic") patch.phase = "plan";
      if (ev.type === "locate.done") {
        patch.phase = "code";
        if (!prev.recallSettled) patch.recallSettled = true;
      }
      if (ev.type === "clarify.done")   patch.phase = "locate";
      if (ev.type === "code.done")      patch.phase = "verify";
      if (ev.type === "verify.running") patch.phase = "verify";
      if (ev.type === "verify.done")    patch.phase = "commit";
      if (ev.type === "commit.done")    patch.phase = "done";
      if (ev.type === "run.completed")  { patch.phase = "done"; patch.done = true; }
      if (ev.type === "run.error")      { patch.error = String(ev.payload.message ?? "unknown error"); patch.done = true; }
      if (ev.type === "recall.dismissed") {
        const hid = String(ev.payload.historicalRunId);
        const next = new Set(prev.dismissedRunIds);
        next.add(hid);
        patch.dismissedRunIds = next;
      }

      return { ...prev, ...patch };
    });
  }, []);

  const startRun = useCallback(async (text: string, repoUrl?: string) => {
    esRef.current?.close();
    setState({ ...initial, phase: "starting", dismissedRunIds: new Set() });

    const res = await fetch(`${API}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, ...(repoUrl ? { repoUrl } : {}) }),
    });
    const { runId } = await res.json() as { runId: string };

    setState((prev) => ({ ...prev, runId }));

    const es = new EventSource(`${API}/runs/${runId}/stream`);
    esRef.current = es;

    es.onmessage = (e) => {
      try { appendEvent(JSON.parse(e.data) as RunEvent); } catch { /* ignore */ }
    };
    es.onerror = () => {
      setState((prev) => prev.done ? prev : { ...prev, error: "SSE connection lost", done: true });
      es.close();
    };
  }, [appendEvent]);

  const submitAnswers = useCallback(async (answers: Record<string, string>) => {
    if (!state.runId) return;
    setState((prev) => ({ ...prev, waitingForAnswers: false }));
    await fetch(`${API}/runs/${state.runId}/intervene`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "answer", answers }),
    });
  }, [state.runId]);

  const replayFrom = useCallback(async (fromEventIndex: number, newText: string) => {
    if (!state.runId) return;
    setState((prev) => ({ ...prev, done: false, error: null, phase: "replaying" }));
    await fetch(`${API}/runs/${state.runId}/intervene`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "replay", fromEventIndex, newText }),
    });
  }, [state.runId]);

  const dismissRecall = useCallback(async (historicalRunId: string) => {
    if (!state.runId) return;
    await fetch(`${API}/runs/${state.runId}/dismiss-recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ historicalRunId }),
    });
  }, [state.runId]);

  return { state, startRun, submitAnswers, replayFrom, dismissRecall };
}

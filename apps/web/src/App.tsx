import { useEffect, useMemo, useRef, useState } from "react";
import { useRun } from "./useRun.js";
import { useRunMetrics } from "./useMetrics.js";
import EventCard from "./EventCard.js";
import ClarifyBox from "./ClarifyBox.js";
import ReplayBar from "./ReplayBar.js";
import RunMetricsCard from "./RunMetricsCard.js";
import MetricsPanel from "./MetricsPanel.js";
import RecallCard from "./RecallCard.js";
import { computePrefill } from "./recallTypes.js";
import type { PrefillState } from "./recallTypes.js";

const DEMO_PROMPT = "我想在每篇文章卡片上看到大概要读几分钟";

type Tab = "run" | "metrics";

export default function App() {
  const [tab, setTab] = useState<Tab>("run");
  const [text, setText] = useState(DEMO_PROMPT);
  const { state, startRun, submitAnswers, replayFrom, dismissRecall } = useRun();
  const feedRef = useRef<HTMLDivElement>(null);
  const [running, setRunning] = useState(false);
  const [metricsSignal, setMetricsSignal] = useState(0);

  const { data: runMetrics } = useRunMetrics(state.runId, metricsSignal);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [state.events.length]);

  useEffect(() => {
    setMetricsSignal((s) => s + 1);
  }, [state.events.length, state.done]);

  const handleStart = async () => {
    if (!text.trim() || running) return;
    setRunning(true);
    await startRun(text.trim());
  };

  useEffect(() => {
    if (state.done || state.error) setRunning(false);
  }, [state.done, state.error]);

  // 计算每个澄清问题的预填状态（PM 忽略的历史不参与）
  const prefills: Record<string, PrefillState> = useMemo(() => {
    const map: Record<string, PrefillState> = {};
    for (const q of state.clarifyQuestions) {
      map[q.q] = computePrefill(q, state.recallMatches, state.dismissedRunIds);
    }
    return map;
  }, [state.clarifyQuestions, state.recallMatches, state.dismissedRunIds]);

  const phaseLabel: Record<string, string> = {
    idle: "", starting: "启动中…", clarify: "等待澄清…",
    plan: "规划中…", locate: "定位文件…", code: "生成代码…",
    verify: "验证中…", commit: "提交中…", done: "完成", replaying: "重放中…",
  };

  return (
    <div className="layout">
      <div className="header">
        <div className="header-top">
          <h1>Super Individual</h1>
          <div className="tabs">
            <button className={`tab ${tab === "run" ? "active" : ""}`} onClick={() => setTab("run")}>对话</button>
            <button className={`tab ${tab === "metrics" ? "active" : ""}`} onClick={() => setTab("metrics")}>全局指标</button>
          </div>
        </div>
        <p>PM 自然语言 → Conduit 代码变更</p>
      </div>

      {tab === "metrics" && <MetricsPanel refreshSignal={metricsSignal} />}

      {tab === "run" && (
        <>
          <div className="input-bar">
            <textarea
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="描述你的需求…"
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleStart(); } }}
            />
            <button onClick={handleStart} disabled={running || !text.trim()}>
              {running ? (phaseLabel[state.phase] ?? "运行中…") : "→ 运行"}
            </button>
          </div>

          {/* 召回卡 — 严格在 ClarifyBox 之前渲染 */}
          {state.recallMatches.length > 0 && (
            <RecallCard
              matches={state.recallMatches}
              dismissedRunIds={state.dismissedRunIds}
              onDismiss={(rid) => dismissRecall(rid)}
            />
          )}

          {/* ClarifyBox：必须等 recallSettled，避免预填窗口未到位就闪出空表单 */}
          {state.waitingForAnswers && state.recallSettled && (
            <ClarifyBox
              questions={state.clarifyQuestions}
              prefills={prefills}
              onSubmit={submitAnswers}
            />
          )}

          <div className="feed" ref={feedRef}>
            {state.events.map((ev, i) => (
              <EventCard key={`${ev.ts}-${i}`} event={ev} index={i} />
            ))}
            {state.error && (
              <div className="event-card" style={{ borderColor: "#fc8181" }}>
                <div className="ev-type" style={{ color: "#fc8181" }}>💥 Error</div>
                <pre>{state.error}</pre>
              </div>
            )}
          </div>

          {runMetrics && state.runId && <RunMetricsCard metrics={runMetrics} />}

          {(state.done || state.error) && state.events.length > 0 && (
            <ReplayBar
              events={state.events}
              onReplay={(idx, newText) => {
                setRunning(true);
                replayFrom(idx, newText || text);
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

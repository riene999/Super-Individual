import { useEffect, useMemo, useRef, useState } from "react";
import { useRun } from "./useRun.js";
import { useRepo } from "./useRepo.js";
import { useGlobalMetrics, useRunMetrics } from "./useMetrics.js";
import EventCard from "./EventCard.js";
import ClarifyBox from "./ClarifyBox.js";
import ReplayBar from "./ReplayBar.js";
import RunMetricsCard from "./RunMetricsCard.js";
import MetricsPanel from "./MetricsPanel.js";
import RecallCard from "./RecallCard.js";
import RepoPanel from "./RepoPanel.js";
import { computePrefill } from "./recallTypes.js";
import type { PrefillState } from "./recallTypes.js";

const DEMO_PROMPT = "我想在每篇文章卡片上看到大概要读几分钟";

function fmtCost(v: number): string {
  return `¥${v.toFixed(4)}`;
}

export default function App() {
  const [text, setText] = useState(DEMO_PROMPT);
  const { state, startRun, submitAnswers, replayFrom, dismissRecall } = useRun();
  const { state: repoState, setRepoUrl, cloneRepo } = useRepo();
  const feedRef = useRef<HTMLDivElement>(null);
  const [running, setRunning] = useState(false);
  const [metricsSignal, setMetricsSignal] = useState(0);

  const { data: runMetrics } = useRunMetrics(state.runId, metricsSignal);
  const { data: globalMetrics, loading: globalLoading, refresh: refreshGlobalMetrics } = useGlobalMetrics(metricsSignal);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [state.events.length]);

  useEffect(() => {
    setMetricsSignal((s) => s + 1);
  }, [state.events.length, state.done]);

  const repoReady = repoState.status === "ready";

  const handleStart = async () => {
    if (!text.trim() || running || !repoReady) return;
    setRunning(true);
    await startRun(text.trim(), repoState.repoUrl);
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
    verify: "验证中…", commit: "提交中…", pr: "提交 PR…", done: "完成", replaying: "重放中…",
  };

  const summary = globalMetrics
    ? `${globalMetrics.totalRuns} runs · ${globalMetrics.overall.count} calls · ${fmtCost(globalMetrics.overall.totalCostCNY)}`
    : "metrics pending";

  return (
    <div className="app-shell">
      <header className="header">
        <div>
          <div className="brand">
            <div className="brand-icon"><i className="ti ti-sparkles" aria-hidden="true" /></div>
            <div className="brand-title">Super Individual</div>
          </div>
          <div className="brand-subtitle">PM 自然语言 → Conduit 代码变更</div>
        </div>
        <div className="header-right">
          <span className="stats-summary">{summary}</span>
          <span className="live-badge"><span className="live-dot" />live</span>
        </div>
      </header>

      <main className="layout">
        <section className="main-col">
          <RepoPanel state={repoState} onUrlChange={setRepoUrl} onClone={cloneRepo} />
          <div className="input-card">
            <textarea
              className="input-text"
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="描述你的需求…"
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleStart(); } }}
            />
            <div className="input-footer">
              <div className="input-toggles">
                <span><i className="ti ti-history" aria-hidden="true" />历史召回 启用</span>
                <span><i className="ti ti-search" aria-hidden="true" />aspect 扫描 启用</span>
              </div>
              <button className="run-button" onClick={handleStart} disabled={running || !text.trim() || !repoReady} title={!repoReady ? "请先 Clone 目标仓库" : undefined}>
                {running ? (phaseLabel[state.phase] ?? "运行中…") : "运行"}
                <i className="ti ti-arrow-right" aria-hidden="true" />
              </button>
            </div>
          </div>

          {state.recallMatches.length > 0 && (
            <RecallCard
              matches={state.recallMatches}
              dismissedRunIds={state.dismissedRunIds}
              onDismiss={(rid) => dismissRecall(rid)}
            />
          )}

          {state.waitingForAnswers && state.recallSettled && (
            <ClarifyBox
              questions={state.clarifyQuestions}
              prefills={prefills}
              onSubmit={submitAnswers}
            />
          )}

          <div className="event-stream" ref={feedRef}>
            {state.events
              .filter((ev) => ev.type !== "recall.matched")
              .map((ev, i) => (
                <EventCard key={`${ev.ts}-${i}`} event={ev} index={i} />
              ))}
            {state.error && (
              <div className="event event-error">
                <div className="event-icon danger"><i className="ti ti-circle-x" aria-hidden="true" /></div>
                <div className="event-body">
                  <div className="event-head">
                    <span className="event-title">Run error</span>
                    <span className="event-meta">SSE</span>
                  </div>
                  <pre className="event-desc">{state.error}</pre>
                </div>
              </div>
            )}
          </div>

          {(state.done || state.error) && state.events.length > 0 && (
            <ReplayBar
              events={state.events}
              onReplay={(idx, newText) => {
                setRunning(true);
                replayFrom(idx, newText || text);
              }}
            />
          )}
        </section>

        <aside className="sidebar-col">
          <RunMetricsCard
            metrics={runMetrics}
            running={running}
            phaseLabel={phaseLabel[state.phase] ?? state.phase}
          />
          <MetricsPanel
            data={globalMetrics}
            loading={globalLoading}
            refresh={refreshGlobalMetrics}
          />
        </aside>
      </main>
    </div>
  );
}

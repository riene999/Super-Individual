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
import RunHistoryPanel from "./RunHistoryPanel.js";
import { computePrefill } from "./recallTypes.js";
import type { PrefillState } from "./recallTypes.js";
import { useRecentRuns } from "./useRecentRuns.js";
import type { RecentRun } from "./useRecentRuns.js";

const DEMO_PROMPT = "我想在每篇文章卡片上看到大概要读几分钟";

function fmtCost(v: number): string {
  return `¥${v.toFixed(4)}`;
}

export default function App() {
  const [text, setText] = useState(DEMO_PROMPT);
  const { state, startRun, stopRun, resumeRun, submitAnswers, replayFrom, replayRunFrom, dismissRecall } = useRun();
  const { state: repoState, setRepoUrl, cloneRepo, resetRepo } = useRepo();
  const feedRef = useRef<HTMLDivElement>(null);
  const [running, setRunning] = useState(false);
  const [metricsSignal, setMetricsSignal] = useState(0);
  const [activityTab, setActivityTab] = useState<"events" | "history">("events");
  const [recallEnabled, setRecallEnabled] = useState(true);

  const { data: runMetrics } = useRunMetrics(state.runId, metricsSignal);
  const { data: globalMetrics, loading: globalLoading, refresh: refreshGlobalMetrics } = useGlobalMetrics(metricsSignal);
  const { runs: recentRuns, loading: recentRunsLoading, deleteRunHistory } = useRecentRuns(metricsSignal, 20);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [state.events.length]);

  useEffect(() => {
    setMetricsSignal((s) => s + 1);
  }, [state.events.length, state.done]);

  const repoReady = repoState.status === "ready";

  const handleRunButton = async () => {
    if (running) {
      if (state.phase === "stopping") return;
      await stopRun();
      return;
    }
    if (state.cancelled) {
      setRunning(true);
      await resumeRun();
      return;
    }
    if (!text.trim() || !repoReady) return;
    setRunning(true);
    await startRun(text.trim(), repoState.repoUrl, !recallEnabled);
  };

  const handleStartNewRun = async () => {
    if (!text.trim() || !repoReady || running) return;
    setRunning(true);
    await startRun(text.trim(), repoState.repoUrl, !recallEnabled);
  };

  const handleResetRepo = async (repoUrl: string) => {
    const ok = window.confirm("初始化会丢弃该仓库的本地代码改动，并恢复到原始远端默认分支。确认继续？");
    if (!ok) return;
    await resetRepo(repoUrl);
  };

  const handleDeleteRunHistory = async (run: RecentRun) => {
    const message = run.status === "running"
      ? "这条 run 仍在运行。强制删除会先停止它，再删除历史；不会删除 memory，也不会回滚代码改动。"
      : "删除这条 run 历史？这不会删除 memory，也不会回滚代码改动。";
    const ok = window.confirm(message);
    if (!ok) return;
    await deleteRunHistory(run.runId);
  };

  const handleReplayHistoryRun = async (run: RecentRun, fromIndex: number, newText: string) => {
    setActivityTab("events");
    setRunning(true);
    await replayRunFrom(run.runId, fromIndex, newText || run.rawText);
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
    verify: "验证中…", commit: "提交中…", pr: "提交 PR…", done: "完成", stopping: "停止中…", cancelled: "已停止", replaying: "重放中…",
  };

  // 状态条用：通俗易懂的中文阶段名（不带“…”，省略号由动画补）
  const stageWord: Record<string, string> = {
    starting: "启动", recall: "查历史", "code-spec": "读代码规范", plan: "规划",
    clarify: "等你回答", locate: "找要改的文件", code: "写代码", verify: "验证代码",
    "code-spec:update": "更新代码规范", commit: "提交代码", pr: "提交 PR", replaying: "重放",
  };
  const stageActive = running && !state.done && !state.error;
  const stageWordText = state.waitingForAnswers ? "等你回答" : (stageWord[state.stage] ?? "处理");

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
          <RepoPanel state={repoState} onUrlChange={setRepoUrl} onClone={cloneRepo} onReset={handleResetRepo} resetDisabled={running} />
          <div className="input-card">
            <textarea
              className="input-text"
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="描述你的需求…"
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleRunButton(); } }}
            />
            <div className="input-footer">
              <div className="input-toggles">
                <button
                  type="button"
                  className={`toggle-chip ${recallEnabled ? "on" : "off"}`}
                  onClick={() => setRecallEnabled((v) => !v)}
                  aria-pressed={recallEnabled}
                  title="开/关历史召回：是否检索相似历史需求作为规划参考"
                >
                  <i className="ti ti-history" aria-hidden="true" />历史召回 {recallEnabled ? "启用" : "停用"}
                </button>
              </div>
              <div className="run-actions">
              <button
                className={`run-button ${running ? "stop" : state.cancelled ? "resume" : "play"}`}
                onClick={handleRunButton}
                disabled={(running && state.phase === "stopping") || (!running && !state.cancelled && (!text.trim() || !repoReady))}
                title={!repoReady && !running && !state.cancelled ? "请先 Clone 目标仓库" : running ? "停止" : state.cancelled ? "继续" : "运行"}
                aria-label={running ? "停止" : state.cancelled ? "继续" : "运行"}
              >
                {running ? "停止" : state.cancelled ? "继续" : null}
                <i className={`ti ${running ? "ti-player-stop" : state.cancelled ? "ti-rewind" : "ti-player-play"}`} aria-hidden="true" />
              </button>
              {state.cancelled && !running && (
                <button
                  className="run-button play restart"
                  onClick={handleStartNewRun}
                  disabled={!text.trim() || !repoReady}
                  title="重新开始"
                  aria-label="重新开始"
                >
                  <i className="ti ti-player-play" aria-hidden="true" />
                </button>
              )}
              </div>
            </div>
          </div>

          <ReplayBar
            events={state.events}
            onReplay={(idx, newText) => {
              setRunning(true);
              replayFrom(idx, newText || text);
            }}
          />

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

          <div className="activity-panel">
            <div className="activity-tabs">
              <button className={activityTab === "events" ? "active" : ""} onClick={() => setActivityTab("events")}>事件流</button>
              <button className={activityTab === "history" ? "active" : ""} onClick={() => setActivityTab("history")}>对话历史</button>
            </div>

            {activityTab === "events" ? (
              <div className="event-stream" ref={feedRef}>
                {stageActive ? (
                  <div className="stage-bar">
                    <span className="stage-icon"><i className="ti ti-activity" aria-hidden="true" /></span>
                    <span className="stage-text">
                      {stageWordText}中
                      <span className="stage-dots"><i /><i /><i /></span>
                    </span>
                  </div>
                ) : (
                  state.events.filter((ev) => ev.type !== "recall.matched").length === 0 && !state.error && (
                    <div className="activity-empty">运行阶段信息会显示在这里</div>
                  )
                )}
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
            ) : (
              <RunHistoryPanel
                runs={recentRuns}
                loading={recentRunsLoading}
                onDelete={handleDeleteRunHistory}
                onReplay={handleReplayHistoryRun}
              />
            )}
          </div>

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

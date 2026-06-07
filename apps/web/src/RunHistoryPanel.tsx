import { useEffect, useMemo, useState } from "react";
import type { RunEvent } from "./types.js";
import type { RecentRun } from "./useRecentRuns.js";

interface Props {
  runs: RecentRun[];
  loading: boolean;
  onDelete: (run: RecentRun) => void;
  onReplay: (run: RecentRun, fromIndex: number, newText: string) => void;
}

interface RunDetail {
  runId: string;
  phase: string;
  events: RunEvent[];
}

const STATUS_LABEL: Record<RecentRun["status"], string> = {
  running: "运行中",
  completed: "完成",
  cancelled: "已停止",
  error: "错误",
};

const REPLAYABLE_TYPES = new Set([
  "run.started",
  "clarify.done",
  "plan.done",
  "plan.generic",
  "locate.done",
  "code.done",
]);

function fmtTime(ts: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleString();
}

export default function RunHistoryPanel({ runs, loading, onDelete, onReplay }: Props) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [replayIndex, setReplayIndex] = useState(0);
  const [replayText, setReplayText] = useState("");

  const replayOptions = useMemo(() => {
    return (detail?.events ?? [])
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => REPLAYABLE_TYPES.has(event.type));
  }, [detail]);

  useEffect(() => {
    if (!selectedRunId) {
      setDetail(null);
      return;
    }

    let cancelled = false;
    setDetailLoading(true);
    fetch(`/api/runs/${selectedRunId}`)
      .then((res) => res.json())
      .then((data: RunDetail) => {
        if (cancelled) return;
        setDetail(data);
        const firstReplayable = data.events.findIndex((event) => REPLAYABLE_TYPES.has(event.type));
        setReplayIndex(firstReplayable >= 0 ? firstReplayable : 0);
        setReplayText("");
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedRunId]);

  if (loading && runs.length === 0) {
    return <div className="activity-empty">正在加载对话历史…</div>;
  }

  if (runs.length === 0) {
    return <div className="activity-empty">暂无对话历史</div>;
  }

  return (
    <div className="run-history">
      {runs.map((run) => {
        const selected = run.runId === selectedRunId;
        return (
          <div className={`run-history-row ${selected ? "selected" : ""}`} key={run.runId}>
            <div className="run-history-item" onClick={() => setSelectedRunId(selected ? null : run.runId)}>
              <div className="run-history-main">
                <div className="run-history-title">{run.rawText || "(空需求)"}</div>
                <div className="run-history-meta">
                  <span>{fmtTime(run.updatedAt)}</span>
                  <span>{run.eventCount} events</span>
                  {run.repoNwo && <span>{run.repoNwo}</span>}
                  <span>{run.lastEventType}</span>
                </div>
              </div>
              <div className="run-history-actions">
                <span className={`run-status ${run.status}`}>{STATUS_LABEL[run.status]}</span>
                <button
                  className="run-delete"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete(run);
                  }}
                  title={run.status === "running" ? "会先停止 run，再删除历史记录" : "只删除历史记录，不回滚代码改动"}
                >
                  删除历史
                </button>
              </div>
            </div>

            {selected && (
              <div className="run-history-detail">
                {detailLoading ? (
                  <div className="run-history-detail-empty">正在加载阶段…</div>
                ) : replayOptions.length === 0 ? (
                  <div className="run-history-detail-empty">没有可重放阶段</div>
                ) : (
                  <>
                    <div className="run-history-warning">重放会截断该 run 在所选阶段之后的历史事件。</div>
                    <div className="run-history-replay">
                      <select value={replayIndex} onChange={(event) => setReplayIndex(Number(event.target.value))}>
                        {replayOptions.map(({ event, index }) => (
                          <option key={index} value={index}>#{index} {event.type}</option>
                        ))}
                      </select>
                      <input
                        value={replayText}
                        onChange={(event) => setReplayText(event.target.value)}
                        placeholder="修改后的需求（留空则使用原始需求）"
                        disabled={run.status === "running"}
                      />
                      <button
                        disabled={run.status === "running"}
                        title={run.status === "running" ? "正在运行的 run 不能重放" : undefined}
                        onClick={() => onReplay(run, replayIndex + 1, replayText || run.rawText)}
                      >
                        从此阶段重放
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

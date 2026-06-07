import type { RecentRun } from "./useRecentRuns.js";

interface Props {
  runs: RecentRun[];
  loading: boolean;
  onDelete: (run: RecentRun) => void;
}

const STATUS_LABEL: Record<RecentRun["status"], string> = {
  running: "运行中",
  completed: "完成",
  cancelled: "已停止",
  error: "错误",
};

function fmtTime(ts: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleString();
}

export default function RunHistoryPanel({ runs, loading, onDelete }: Props) {
  if (loading && runs.length === 0) {
    return <div className="activity-empty">正在加载对话历史…</div>;
  }

  if (runs.length === 0) {
    return <div className="activity-empty">暂无对话历史</div>;
  }

  return (
    <div className="run-history">
      {runs.map((run) => (
        <div className="run-history-item" key={run.runId}>
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
              disabled={run.status === "running"}
              onClick={() => onDelete(run)}
              title={run.status === "running" ? "正在运行的历史不能删除" : "只删除历史记录，不回滚代码改动"}
            >
              删除历史
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

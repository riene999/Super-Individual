import type { RepoState } from "./useRepo.js";

interface RepoPanelProps {
  state: RepoState;
  onUrlChange: (url: string) => void;
  onClone: (url: string) => void;
  onReset: (url: string) => void;
  resetDisabled?: boolean;
}

export default function RepoPanel({ state, onUrlChange, onClone, onReset, resetDisabled = false }: RepoPanelProps) {
  const { repoUrl, nwo, status, error } = state;
  const busy = status === "cloning" || status === "resetting";

  return (
    <div className="repo-panel">
      <div className="repo-panel-label">
        <i className="ti ti-brand-github" aria-hidden="true" />
        目标仓库
        {nwo && status === "ready" && (
          <span className="repo-badge ready">
            <i className="ti ti-circle-check" aria-hidden="true" />
            {nwo}
          </span>
        )}
      </div>
      <div className="repo-panel-row">
        <input
          className="repo-url-input"
          type="url"
          value={repoUrl}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder="https://github.com/owner/repo"
          onKeyDown={(e) => { if (e.key === "Enter" && !busy) onClone(repoUrl); }}
          disabled={busy}
        />
        <button
          className="repo-clone-btn"
          onClick={() => onClone(repoUrl)}
          disabled={!repoUrl.trim() || busy}
        >
          {status === "cloning" ? (
            <><i className="ti ti-loader-2 spin" aria-hidden="true" />Clone 中…</>
          ) : (
            <><i className="ti ti-download" aria-hidden="true" />Clone</>
          )}
        </button>
        <button
          className="repo-reset-btn"
          onClick={() => onReset(repoUrl)}
          disabled={!repoUrl.trim() || busy || !nwo || resetDisabled}
          title="丢弃本地代码改动，恢复到原始远端默认分支"
        >
          {status === "resetting" ? (
            <><i className="ti ti-loader-2 spin" aria-hidden="true" />初始化中…</>
          ) : (
            <><i className="ti ti-rewind" aria-hidden="true" />初始化</>
          )}
        </button>
      </div>
      {error && <div className="repo-error">{error}</div>}
    </div>
  );
}

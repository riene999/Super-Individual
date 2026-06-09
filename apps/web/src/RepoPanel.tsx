import type { RepoState } from "./useRepo.js";

interface RepoPanelProps {
  state: RepoState;
  onUrlChange: (url: string) => void;
  onClone: (url: string) => void;
  onReset: (url: string) => void;
  onRebuildSpec: (url: string) => void;
  resetDisabled?: boolean;
}

export default function RepoPanel({ state, onUrlChange, onClone, onReset, onRebuildSpec, resetDisabled = false }: RepoPanelProps) {
  const { repoUrl, nwo, status, error } = state;
  const busy = status === "cloning" || status === "resetting" || status === "rebuilding";
  const specReady = Boolean(state.spec?.currentReady);

  return (
    <div className="repo-panel">
      <div className="repo-panel-label">
        <i className="ti ti-brand-github" aria-hidden="true" />
        目标仓库
        {nwo && (status === "ready" || status === "rebuilding") && (
          <span className="repo-badge ready">
            <i className="ti ti-circle-check" aria-hidden="true" />
            {nwo}
          </span>
        )}
        {nwo && (status === "ready" || status === "rebuilding") && (
          <span className="spec-status">
            {specReady && (
              <span className="repo-badge ready">
                <i className="ti ti-file-check" aria-hidden="true" />
                规范 {state.spec?.fileCount ?? 0}
              </span>
            )}
            <button
              className="spec-action-btn"
              onClick={() => onRebuildSpec(repoUrl)}
              disabled={busy || resetDisabled}
              title={specReady ? "重新摘要全部文件，重建代码规范索引（含接口签名）" : "摘要全部文件，创建代码规范索引"}
            >
              {status === "rebuilding" ? (
                <><i className="ti ti-loader-2 spin" aria-hidden="true" />{specReady ? "重建中…" : "创建中…"}</>
              ) : specReady ? (
                <><i className="ti ti-refresh" aria-hidden="true" />重建</>
              ) : (
                <><i className="ti ti-sparkles" aria-hidden="true" />创建规范</>
              )}
            </button>
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

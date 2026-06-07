import type { RepoState } from "./useRepo.js";

interface RepoPanelProps {
  state: RepoState;
  onUrlChange: (url: string) => void;
  onClone: (url: string) => void;
}

export default function RepoPanel({ state, onUrlChange, onClone }: RepoPanelProps) {
  const { repoUrl, nwo, status, error } = state;

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
          onKeyDown={(e) => { if (e.key === "Enter") onClone(repoUrl); }}
          disabled={status === "cloning"}
        />
        <button
          className="repo-clone-btn"
          onClick={() => onClone(repoUrl)}
          disabled={!repoUrl.trim() || status === "cloning"}
        >
          {status === "cloning" ? (
            <><i className="ti ti-loader-2 spin" aria-hidden="true" />拉取中…</>
          ) : (
            <><i className="ti ti-download" aria-hidden="true" />Clone</>
          )}
        </button>
      </div>
      {error && <div className="repo-error">{error}</div>}
    </div>
  );
}

import type { RecallMatchView } from "./recallTypes.js";
import { splitDimensions } from "./recallTypes.js";

interface Props {
  matches: RecallMatchView[];
  dismissedRunIds: Set<string>;
  onDismiss: (historicalRunId: string) => void;
}

export default function RecallCard({ matches, dismissedRunIds, onDismiss }: Props) {
  const visible = matches.filter((m) => !dismissedRunIds.has(m.runId));
  if (visible.length === 0) return null;

  return (
    <div className="recall-card">
      <div className="recall-header">📎 找到 {visible.length} 条相似历史</div>
      {visible.map((m) => (
        <RecallEntry key={m.runId} match={m} onDismiss={() => onDismiss(m.runId)} />
      ))}
    </div>
  );
}

function RecallEntry({ match, onDismiss }: { match: RecallMatchView; onDismiss: () => void }) {
  const { primary, secondary } = splitDimensions(match.matchedDimensions);
  const pct = Math.round(match.score * 100);
  const failed = match.outcome === "failed";

  return (
    <div
      className={`recall-entry ${failed ? "recall-failed" : ""}`}
      data-failed={failed ? "true" : "false"}
      data-run-id={match.runId}
    >
      {failed && <div className="recall-warn">⚠ 此需求当时未通过验证，仅供参考</div>}

      <div className="recall-row-head">
        <span className="recall-run-id">run #{match.runId.slice(0, 4)}</span>
        <span className="recall-pct">{pct}% 相似</span>
        <span className={`recall-outcome ${failed ? "neg" : "pos"}`}>{failed ? "failed" : "verified"}</span>
      </div>

      {primary.length > 0 && (
        <div className="recall-line primary">
          <span className="lbl">主要因为:</span> {primary.join("，")}
        </div>
      )}
      {secondary.length > 0 && (
        <div className="recall-line secondary">
          <span className="lbl">也涉及:</span> {secondary.join("，")}
        </div>
      )}

      {match.clarifications.length > 0 && (
        <div className="recall-clarifications">
          <div className="recall-clarif-title">上次澄清:</div>
          {match.clarifications.map((c, i) => (
            <div className="recall-clarif-row" key={i}>
              <span className="aspect-chip">{c.aspect ?? "other"}</span>
              <span className="clarif-a">{c.a}</span>
            </div>
          ))}
        </div>
      )}

      <div className="recall-actions">
        <button className="btn-dismiss" onClick={onDismiss}>忽略此条历史</button>
      </div>
    </div>
  );
}

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

  const top = visible[0];
  const pct = Math.round(top.score * 100);

  return (
    <div className="event recall-event">
      <div className="event-icon recall"><i className="ti ti-history" aria-hidden="true" /></div>
      <div className="event-body recall-card">
        <div className="recall-head">
          <span className="recall-title">Recall matched · {visible.length} 历史命中</span>
          <span className="recall-score">top #{top.runId.slice(0, 4)} · {pct}%</span>
        </div>
        {visible.map((m) => (
          <RecallEntry key={m.runId} match={m} onDismiss={() => onDismiss(m.runId)} />
        ))}
      </div>
    </div>
  );
}

function RecallEntry({ match, onDismiss }: { match: RecallMatchView; onDismiss: () => void }) {
  const { primary, secondary } = splitDimensions(match.matchedDimensions);
  const failed = match.outcome === "failed";

  return (
    <div className={`recall-entry ${failed ? "recall-failed" : ""}`} data-failed={failed ? "true" : "false"}>
      {failed && (
        <div className="recall-warn">
          <i className="ti ti-alert-triangle" aria-hidden="true" />
          此需求当时未通过验证，仅供参考
        </div>
      )}

      <div className="recall-dims">
        {primary.length > 0 && (
          <div><span className="recall-dim-label">主要因为</span> {primary.join(" · ")}</div>
        )}
        {secondary.length > 0 && (
          <div><span className="recall-dim-label">也涉及</span> {secondary.join(" · ")}</div>
        )}
      </div>

      {match.clarifications.length > 0 && (
        <div className="recall-divider">
          <div className="recall-qa-title">上次澄清</div>
          {match.clarifications.slice(0, 4).map((c, i) => (
            <div className="recall-qa-row" key={i}>
              <span className="recall-qa-q">{c.aspect ?? "other"}</span>
              <span className="recall-qa-a">{c.a}</span>
            </div>
          ))}
        </div>
      )}

      <div className="recall-actions">
        <button className="recall-btn-primary" type="button">复用上次答案</button>
        <button className="recall-btn-secondary" type="button" onClick={onDismiss}>忽略此条历史</button>
      </div>
    </div>
  );
}

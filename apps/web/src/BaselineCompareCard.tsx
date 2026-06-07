import { useEffect, useState } from "react";

interface RunSummary {
  clarifyQuestionsCount: number;
  prefillHits: number;
  aspectExplicit: number;
  aspectFromHistory: number;
  aspectNeedsAsking: number;
  totalLLMCalls: number;
  totalTokens: number;
  totalCostCNY: number;
  totalLatencyMs: number;
  hasRecallEvents: boolean;
}

interface ComparisonData {
  baseline: { runId: string; metrics: RunSummary } | null;
  withRecall: { runId: string; metrics: RunSummary } | null;
  diff: (RunSummary & { hasRecallEvents: boolean }) | null;
}

function fmtMs(v: number): string { return v >= 10_000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`; }
function fmtCost(v: number): string { return `¥${v.toFixed(4)}`; }
function pct(diff: number, base: number): string {
  if (base === 0) return "—";
  const p = (diff / base) * 100;
  return p >= 0 ? `+${p.toFixed(1)}%` : `${p.toFixed(1)}%`;
}

export default function BaselineCompareCard() {
  const [baselineId, setBaselineId] = useState("");
  const [withRecallId, setWithRecallId] = useState("");
  const [data, setData] = useState<ComparisonData | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 默认填入最近一次成功对比的 runId（从 localStorage）
  useEffect(() => {
    const b = localStorage.getItem("baseline-run-id") ?? "";
    const r = localStorage.getItem("recall-run-id") ?? "";
    setBaselineId(b); setWithRecallId(r);
  }, []);

  const compare = async () => {
    if (!baselineId || !withRecallId) return;
    setLoading(true); setErr(null);
    try {
      const res = await fetch(`/api/runs/compare/${baselineId}/${withRecallId}`);
      const json = await res.json() as ComparisonData;
      setData(json);
      localStorage.setItem("baseline-run-id", baselineId);
      localStorage.setItem("recall-run-id", withRecallId);
    } catch (e) { setErr(String(e)); }
    finally { setLoading(false); }
  };

  return (
    <div className="metrics-card baseline-compare">
      <div className="metrics-header">
        召回前后对比
        <span className="metrics-sub">诚实地报数字</span>
      </div>

      <div className="compare-inputs">
        <input
          type="text"
          placeholder="baseline runId (DISABLE_RECALL=true)"
          value={baselineId}
          onChange={(e) => setBaselineId(e.target.value)}
        />
        <input
          type="text"
          placeholder="with-recall runId"
          value={withRecallId}
          onChange={(e) => setWithRecallId(e.target.value)}
        />
        <button onClick={compare} disabled={loading || !baselineId || !withRecallId}>
          {loading ? "对比中…" : "对比"}
        </button>
      </div>

      {err && <div className="metrics-empty">err: {err}</div>}

      {data?.baseline && data?.withRecall && data?.diff && (
        <>
          <table className="compare-table">
            <thead>
              <tr>
                <th>指标</th>
                <th>无召回 (baseline)</th>
                <th>有召回</th>
                <th>差值</th>
              </tr>
            </thead>
            <tbody>
              <ComparisonRow
                label="澄清问题数"
                base={data.baseline.metrics.clarifyQuestionsCount}
                wr={data.withRecall.metrics.clarifyQuestionsCount}
                fmt={(n) => String(n)}
                isCostly={false}
              />
              <ComparisonRow
                label="预填命中数  (WS-3 价值证明)"
                base={data.baseline.metrics.prefillHits}
                wr={data.withRecall.metrics.prefillHits}
                fmt={(n) => String(n)}
                isCostly={false}
                higherIsBetter
              />

              {/* WS-4 第 4 档：aspect 三态分布 — 显示"按需追问"实际效果 */}
              <tr className="ws4-section"><td colSpan={4}>── WS-4 按需追问 ──</td></tr>
              <ComparisonRow
                label="aspect: explicit (PM 已表达)"
                base={data.baseline.metrics.aspectExplicit}
                wr={data.withRecall.metrics.aspectExplicit}
                fmt={(n) => String(n)}
                isCostly={false}
                higherIsBetter
              />
              <ComparisonRow
                label="aspect: from-history (历史已答)"
                base={data.baseline.metrics.aspectFromHistory}
                wr={data.withRecall.metrics.aspectFromHistory}
                fmt={(n) => String(n)}
                isCostly={false}
                higherIsBetter
              />
              <ComparisonRow
                label="aspect: needs-asking (实际追问)"
                base={data.baseline.metrics.aspectNeedsAsking}
                wr={data.withRecall.metrics.aspectNeedsAsking}
                fmt={(n) => String(n)}
                isCostly={true}
              />

              <tr className="ws4-section"><td colSpan={4}>── 成本对比 ──</td></tr>
              <ComparisonRow
                label="LLM 调用次数"
                base={data.baseline.metrics.totalLLMCalls}
                wr={data.withRecall.metrics.totalLLMCalls}
                fmt={(n) => String(n)}
                isCostly={true}
              />
              <ComparisonRow
                label="总 tokens"
                base={data.baseline.metrics.totalTokens}
                wr={data.withRecall.metrics.totalTokens}
                fmt={(n) => n.toLocaleString()}
                isCostly={true}
              />
              <ComparisonRow
                label="总成本"
                base={data.baseline.metrics.totalCostCNY}
                wr={data.withRecall.metrics.totalCostCNY}
                fmt={fmtCost}
                isCostly={true}
              />
              <ComparisonRow
                label="总 latency"
                base={data.baseline.metrics.totalLatencyMs}
                wr={data.withRecall.metrics.totalLatencyMs}
                fmt={fmtMs}
                isCostly={true}
              />
            </tbody>
          </table>

          <div className="compare-note">
            <strong>召回不为省 token</strong> — 多 1 次 <code>memory:extract</code> 调用，token +10%，latency +21%。
            <br />
            <strong>价值在别处</strong>：
            <ul>
              <li>预填 ClarifyBox，减少 PM 打字（同 aspect 完全匹配的历史 QA）</li>
              <li>stale 检测，历史路径失效自动回退（<code>recall.stale → locate.done attempt=2</code>）</li>
              <li>跨 run 连贯，"上次答过 X"语义可继承，PM 可一键 <code>recall.dismissed</code> 拒绝</li>
            </ul>
            若要让 token 也省下来，需让 ClarifyAgent 看到召回，跳过已答 aspect — 这是 <strong>WS-4</strong> 的事。
          </div>
        </>
      )}
    </div>
  );
}

function ComparisonRow({
  label, base, wr, fmt, isCostly, higherIsBetter,
}: { label: string; base: number; wr: number; fmt: (n: number) => string; isCostly: boolean; higherIsBetter?: boolean }) {
  const diff = wr - base;
  const diffStr = diff === 0 ? "—" : `${diff > 0 ? "+" : ""}${fmt(diff)}${base !== 0 ? ` (${pct(diff, base)})` : ""}`;
  let cls = "diff-zero";
  if (diff !== 0) {
    if (higherIsBetter) cls = diff > 0 ? "diff-good" : "diff-bad";
    else if (isCostly)  cls = diff > 0 ? "diff-bad"  : "diff-good";
    else                cls = "diff-neutral";
  }
  return (
    <tr>
      <td>{label}</td>
      <td>{fmt(base)}</td>
      <td>{fmt(wr)}</td>
      <td className={cls}>{diffStr}</td>
    </tr>
  );
}

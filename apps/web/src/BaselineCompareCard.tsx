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
  if (base === 0) return "";
  const p = (diff / base) * 100;
  return p >= 0 ? `+${p.toFixed(1)}%` : `${p.toFixed(1)}%`;
}

export default function BaselineCompareCard() {
  const [baselineId, setBaselineId] = useState("");
  const [withRecallId, setWithRecallId] = useState("");
  const [data, setData] = useState<ComparisonData | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const b = localStorage.getItem("baseline-run-id") ?? "";
    const r = localStorage.getItem("recall-run-id") ?? "";
    setBaselineId(b);
    setWithRecallId(r);
  }, []);

  const compare = async () => {
    if (!baselineId || !withRecallId) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`/api/runs/compare/${baselineId}/${withRecallId}`);
      const json = await res.json() as ComparisonData;
      setData(json);
      localStorage.setItem("baseline-run-id", baselineId);
      localStorage.setItem("recall-run-id", withRecallId);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="sidebar-card baseline-compare">
      <div className="sidebar-head">
        <span className="sidebar-title">召回前后对比</span>
        <span className="sidebar-meta">诚实地报</span>
      </div>

      <div className="compare-inputs">
        <input
          type="text"
          placeholder="baseline runId"
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
          <div className="compare-table">
            <div className="compare-row compare-head-row">
              <span>指标</span>
              <span className="compare-baseline">baseline</span>
              <span className="compare-recall">+ recall</span>
            </div>
            <ComparisonRow label="澄清问题数" base={data.baseline.metrics.clarifyQuestionsCount} wr={data.withRecall.metrics.clarifyQuestionsCount} fmt={String} isCostly={false} />
            <ComparisonRow label="prefill hits" base={data.baseline.metrics.prefillHits} wr={data.withRecall.metrics.prefillHits} fmt={String} isCostly={false} higherIsBetter />
            <div className="compare-section">WS-4 按需追问</div>
            <ComparisonRow label="aspect: explicit" base={data.baseline.metrics.aspectExplicit} wr={data.withRecall.metrics.aspectExplicit} fmt={String} isCostly={false} higherIsBetter />
            <ComparisonRow label="aspect: from-history" base={data.baseline.metrics.aspectFromHistory} wr={data.withRecall.metrics.aspectFromHistory} fmt={String} isCostly={false} higherIsBetter />
            <ComparisonRow label="aspect: needs-asking" base={data.baseline.metrics.aspectNeedsAsking} wr={data.withRecall.metrics.aspectNeedsAsking} fmt={String} isCostly />
            <div className="compare-section">成本对比</div>
            <ComparisonRow label="LLM 调用次数" base={data.baseline.metrics.totalLLMCalls} wr={data.withRecall.metrics.totalLLMCalls} fmt={String} isCostly />
            <ComparisonRow label="总 tokens" base={data.baseline.metrics.totalTokens} wr={data.withRecall.metrics.totalTokens} fmt={(n) => n.toLocaleString()} isCostly />
            <ComparisonRow label="总成本" base={data.baseline.metrics.totalCostCNY} wr={data.withRecall.metrics.totalCostCNY} fmt={fmtCost} isCostly />
            <ComparisonRow label="总 latency" base={data.baseline.metrics.totalLatencyMs} wr={data.withRecall.metrics.totalLatencyMs} fmt={fmtMs} isCostly />
          </div>

          <div className="compare-note">
            <strong>召回不为省 token</strong>，多 1 次 <code>memory:extract</code> 调用，token +10%，latency +21%。
            <br />
            <strong>价值在别处</strong>：预填 ClarifyBox、防 stale 路径、跨 run 连贯，PM 仍可一键 <code>recall.dismissed</code> 拒绝。
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
  const diffPct = pct(diff, base);
  const diffStr = diff === 0 ? "" : ` ${diff > 0 ? "+" : ""}${fmt(diff)}${diffPct ? ` (${diffPct})` : ""}`;
  let cls = "diff-zero";
  if (diff !== 0) {
    if (higherIsBetter) cls = diff > 0 ? "diff-good" : "diff-bad";
    else if (isCostly) cls = diff > 0 ? "diff-bad" : "diff-good";
    else cls = "diff-neutral";
  }
  return (
    <div className="compare-row">
      <span className="compare-label">{label}</span>
      <span className="compare-baseline">{fmt(base)}</span>
      <span className={`compare-recall ${cls}`}>{fmt(wr)}{diffStr}</span>
    </div>
  );
}

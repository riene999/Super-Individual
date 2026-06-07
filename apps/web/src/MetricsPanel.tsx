import type { Stats } from "./metricsTypes.js";
import { agentColor, SAMPLE_THRESHOLD } from "./metricsTypes.js";
import { useGlobalMetrics } from "./useMetrics.js";
import BaselineCompareCard from "./BaselineCompareCard.js";

function fmtCost(v: number): string { return `¥${v.toFixed(4)}`; }
function fmtMs(v: number): string {
  return v >= 10_000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
}

export default function MetricsPanel({ refreshSignal }: { refreshSignal: number }) {
  const { data, loading, refresh } = useGlobalMetrics(refreshSignal);

  if (loading && !data) return <div className="metrics-panel"><div className="metrics-empty">加载中…</div></div>;
  if (!data) return <div className="metrics-panel"><div className="metrics-empty">数据不可用</div></div>;

  if (data.overall.count === 0) {
    return (
      <div className="metrics-panel">
        <div className="metrics-header">全局指标</div>
        <div className="metrics-empty">还没有 LLM 调用记录。跑一次需求后再来看。</div>
      </div>
    );
  }

  const { overall, byAgent, totalRuns } = data;
  const showPercentiles = overall.count >= SAMPLE_THRESHOLD;

  // 按总成本排序，最烧钱的 agent 在上面
  const agents = Object.entries(byAgent).sort((a, b) => b[1].totalCostCNY - a[1].totalCostCNY);
  const maxCost = Math.max(...agents.map(([, s]) => s.totalCostCNY), 0.0001);
  const maxLatency = Math.max(...agents.map(([, s]) => s.latency.max), 1);

  return (
    <div className="metrics-panel">
      <div className="metrics-header">
        全局指标
        <span className="metrics-sub">{totalRuns} runs · {overall.count} calls</span>
        <button className="metrics-refresh" onClick={refresh}>刷新</button>
      </div>

      {/* KPI 顶栏 */}
      <div className="kpi-row">
        <div className="kpi"><div className="kpi-num">{overall.count}</div><div className="kpi-lbl">总调用</div></div>
        <div className="kpi"><div className="kpi-num">{overall.totalTokens.toLocaleString()}</div><div className="kpi-lbl">总 tokens</div></div>
        <div className="kpi"><div className="kpi-num">{fmtCost(overall.totalCostCNY)}</div><div className="kpi-lbl">总成本</div></div>
        {showPercentiles ? (
          <>
            <div className="kpi"><div className="kpi-num">{fmtMs(overall.latency.p50)}</div><div className="kpi-lbl">Latency p50</div></div>
            <div className="kpi"><div className="kpi-num">{fmtMs(overall.latency.p95)}</div><div className="kpi-lbl">Latency p95</div></div>
          </>
        ) : (
          <>
            <div className="kpi"><div className="kpi-num">{fmtMs(overall.latency.median)}</div><div className="kpi-lbl">Latency 中位</div></div>
            <div className="kpi"><div className="kpi-num">{fmtMs(overall.latency.max)}</div><div className="kpi-lbl">Latency 最大</div></div>
          </>
        )}
      </div>

      {/* 修正 2 提示 */}
      {!showPercentiles && (
        <div className="sample-warn">样本数 {overall.count} &lt; {SAMPLE_THRESHOLD}，分位数不可靠，展示中位/最大替代</div>
      )}

      {/* WS-3 收尾：召回前后对比 */}
      <BaselineCompareCard />

      {/* 按 agent 横条图 */}
      <div className="bar-section">
        <div className="bar-section-title">按 Agent 分摊成本</div>
        {agents.map(([name, s]) => (
          <AgentBar key={name} name={name} stats={s} maxCost={maxCost} maxLatency={maxLatency} showPercentiles={showPercentiles} />
        ))}
      </div>
    </div>
  );
}

function AgentBar({
  name, stats, maxCost, maxLatency, showPercentiles,
}: {
  name: string; stats: Stats; maxCost: number; maxLatency: number; showPercentiles: boolean;
}) {
  const costPct = (stats.totalCostCNY / maxCost) * 100;
  const latPct = (stats.latency.median / maxLatency) * 100;
  const color = agentColor(name);

  return (
    <div className="agent-row">
      <div className="agent-name" style={{ color }}>{name}</div>
      <div className="agent-bars">
        <div className="bar-bg">
          <div className="bar-fg" style={{ width: `${costPct}%`, background: color }} />
          <span className="bar-label">{fmtCost(stats.totalCostCNY)} · {stats.count} calls · {stats.totalTokens} tokens</span>
        </div>
        <div className="bar-bg secondary">
          <div className="bar-fg" style={{ width: `${latPct}%`, background: color, opacity: 0.5 }} />
          <span className="bar-label">
            {showPercentiles
              ? `p50=${fmtMs(stats.latency.p50)}  p95=${fmtMs(stats.latency.p95)}`
              : `min=${fmtMs(stats.latency.min)}  median=${fmtMs(stats.latency.median)}  max=${fmtMs(stats.latency.max)}`}
          </span>
        </div>
      </div>
    </div>
  );
}

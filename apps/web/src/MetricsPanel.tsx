import type { GlobalMetrics, Stats } from "./metricsTypes.js";

function fmtCost(v: number): string { return `¥${v.toFixed(4)}`; }

interface Props {
  data: GlobalMetrics | null;
  loading: boolean;
  refresh: () => void;
}

export default function MetricsPanel({ data, loading, refresh }: Props) {
  if (loading && !data) {
    return (
      <div className="sidebar-card">
        <div className="sidebar-head">
          <span className="sidebar-title">全局</span>
          <span className="sidebar-meta">loading</span>
        </div>
        <div className="metrics-empty">加载中…</div>
      </div>
    );
  }

  if (!data || data.overall.count === 0) {
    return (
      <>
        <div className="sidebar-card">
          <div className="sidebar-head">
            <span className="sidebar-title">全局</span>
            <button className="metrics-refresh" onClick={refresh}>刷新</button>
          </div>
          <div className="metrics-empty">还没有 LLM 调用记录。跑一次需求后再来看。</div>
        </div>
      </>
    );
  }

  const agents = Object.entries(data.byAgent).sort((a, b) => b[1].totalCostCNY - a[1].totalCostCNY);
  const maxCost = Math.max(...agents.map(([, s]) => s.totalCostCNY), 0.0001);

  return (
    <>
      <div className="sidebar-card">
        <div className="sidebar-head">
          <span className="sidebar-title">全局</span>
          <span className="sidebar-meta">{data.totalRuns} runs · {data.overall.count} calls</span>
          <button className="metrics-refresh" onClick={refresh}>刷新</button>
        </div>
        <div className="timeline-label">按 Agent 成本</div>
        <div className="agent-bars">
          {agents.map(([name, stats], index) => (
            <AgentBar key={name} name={name} stats={stats} maxCost={maxCost} rank={index} />
          ))}
        </div>
      </div>
    </>
  );
}

function AgentBar({ name, stats, maxCost, rank }: { name: string; stats: Stats; maxCost: number; rank: number }) {
  const costPct = (stats.totalCostCNY / maxCost) * 100;
  const colors = ["#534AB7", "#7F77DD", "#AFA9EC", "#CECBF6"];
  const color = colors[Math.min(rank, colors.length - 1)];

  return (
    <div className="agent-bar">
      <div className="agent-bar-head">
        <span className="agent-bar-name">{name}</span>
        <span className="agent-bar-cost">{fmtCost(stats.totalCostCNY)}</span>
      </div>
      <div className="agent-bar-track">
        <div className="agent-bar-fill" style={{ width: `${costPct}%`, background: color }} />
      </div>
    </div>
  );
}

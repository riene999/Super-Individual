import { useState } from "react";
import type { RunMetrics } from "./metricsTypes.js";
import { agentColor, SAMPLE_THRESHOLD } from "./metricsTypes.js";

function fmtCost(v: number): string {
  return `¥${v.toFixed(4)}`;
}
function fmtMs(v: number): string {
  return v >= 10_000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
}

interface Props {
  metrics: RunMetrics | null;
  running: boolean;
  phaseLabel: string;
}

export default function RunMetricsCard({ metrics, running, phaseLabel }: Props) {
  if (!metrics) {
    return (
      <div className="sidebar-card">
        <div className="sidebar-head">
          <span className="sidebar-title">本次 Run</span>
          <span className="sidebar-running">
            <span className="status-dot" />
            {running ? phaseLabel : "等待运行"}
          </span>
        </div>
        <div className="metrics-empty">运行后会在这里显示当前调用、成本和 latency。</div>
      </div>
    );
  }

  if (!metrics.hasLlmEvents) {
    return (
      <div className="sidebar-card">
        <div className="sidebar-head">
          <span className="sidebar-title">本次 Run</span>
          <span className="sidebar-meta">legacy</span>
        </div>
        <div className="metrics-empty">无指标数据 (本次升级前的 run)</div>
      </div>
    );
  }

  const { overall, calls } = metrics;
  const showPercentiles = overall.count >= SAMPLE_THRESHOLD;
  const latencyLabel = showPercentiles ? "Latency p50" : "Latency 中位";
  const latencyValue = showPercentiles ? overall.latency.p50 : overall.latency.median;

  return (
    <div className="sidebar-card">
      <div className="sidebar-head">
        <span className="sidebar-title">本次 Run</span>
        <span className="sidebar-running">
          <span className="status-dot" />
          {running ? phaseLabel : "已同步"}
        </span>
      </div>

      <div className="kpi-grid">
        <div>
          <div className="kpi-label">Calls</div>
          <div className="kpi-value-large">{overall.count}</div>
        </div>
        <div>
          <div className="kpi-label">Cost</div>
          <div className="kpi-value-large accent">{fmtCost(overall.totalCostCNY)}</div>
        </div>
        <div>
          <div className="kpi-label">Tokens</div>
          <div className="kpi-value-small">{overall.totalTokens.toLocaleString()}</div>
        </div>
        <div>
          <div className="kpi-label">{latencyLabel}</div>
          <div className="kpi-value-small">{fmtMs(latencyValue)}</div>
        </div>
      </div>

      <Timeline calls={calls} />
    </div>
  );
}

function Timeline({ calls }: { calls: RunMetrics["calls"] }) {
  const [hover, setHover] = useState<{ idx: number; x: number } | null>(null);
  if (calls.length === 0) return null;

  const W = 280, H = 64, padX = 8, padT = 8, padB = 6;
  const innerW = W - padX * 2;
  const innerH = H - padT - padB;
  const t0 = calls[0].ts;
  const tN = calls[calls.length - 1].ts;
  const tSpan = Math.max(tN - t0, 1);
  const maxLat = Math.max(...calls.map((c) => c.latencyMs), 1);

  return (
    <div className="timeline-wrap">
      <div className="timeline-label">调用时间轴 · y=latency · 色=agent</div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="timeline-svg">
        <line x1="0" y1="58" x2="280" y2="58" className="timeline-axis" />
        <line x1="0" y1="36" x2="280" y2="36" className="timeline-grid" />
        <line x1="0" y1="14" x2="280" y2="14" className="timeline-grid" />
        {calls.map((c, i) => {
          const x = padX + ((c.ts - t0) / tSpan) * innerW;
          const y = padT + (1 - c.latencyMs / maxLat) * innerH;
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r={3.5}
              fill={agentColor(c.agent)}
              onMouseEnter={() => setHover({ idx: i, x })}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}
      </svg>

      {hover && (
        <div className="timeline-hover" style={{ left: `${(hover.x / W) * 100}%` }}>
          <div><strong>{calls[hover.idx].agent}</strong></div>
          <div>latency: {fmtMs(calls[hover.idx].latencyMs)}</div>
          <div>tokens: {calls[hover.idx].promptTokens} + {calls[hover.idx].completionTokens}</div>
          <div>cost: {fmtCost(calls[hover.idx].costCNY)}</div>
        </div>
      )}
    </div>
  );
}

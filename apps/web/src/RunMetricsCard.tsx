import { useState } from "react";
import type { RunMetrics } from "./metricsTypes.js";
import { agentColor, SAMPLE_THRESHOLD } from "./metricsTypes.js";

function fmtCost(v: number): string {
  return `¥${v.toFixed(4)}`;
}
function fmtMs(v: number): string {
  return v >= 10_000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
}

export default function RunMetricsCard({ metrics }: { metrics: RunMetrics }) {
  // 修正 4：旧 run 空态
  if (!metrics.hasLlmEvents) {
    return (
      <div className="metrics-card">
        <div className="metrics-header">本次 Run 指标</div>
        <div className="metrics-empty">无指标数据 (本次升级前的 run)</div>
      </div>
    );
  }

  const { overall, calls } = metrics;
  // 修正 2：count < 阈值 → 只展示 median，不显示 p50/p95
  const showPercentiles = overall.count >= SAMPLE_THRESHOLD;

  return (
    <div className="metrics-card">
      <div className="metrics-header">
        本次 Run 指标 <span className="metrics-sub">{overall.count} calls</span>
      </div>

      {/* KPI 行 */}
      <div className="kpi-row">
        <div className="kpi"><div className="kpi-num">{overall.count}</div><div className="kpi-lbl">Calls</div></div>
        <div className="kpi"><div className="kpi-num">{overall.totalTokens.toLocaleString()}</div><div className="kpi-lbl">Tokens</div></div>
        <div className="kpi"><div className="kpi-num">{fmtCost(overall.totalCostCNY)}</div><div className="kpi-lbl">Cost</div></div>
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

      {/* 时间轴：x=time, y=latency, 颜色=agent，hover 看详情 */}
      <Timeline calls={calls} />
    </div>
  );
}

function Timeline({ calls }: { calls: RunMetrics["calls"] }) {
  const [hover, setHover] = useState<{ idx: number; x: number; y: number } | null>(null);
  if (calls.length === 0) return null;

  const W = 720, H = 140, padL = 36, padR = 12, padT = 12, padB = 22;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const t0 = calls[0].ts;
  const tN = calls[calls.length - 1].ts;
  const tSpan = Math.max(tN - t0, 1);
  const maxLat = Math.max(...calls.map(c => c.latencyMs), 1);

  // y 轴刻度（latency）：3 道
  const ticks = [maxLat, maxLat * 0.5, 0];

  return (
    <div className="timeline-wrap">
      <div className="timeline-title">LLM 调用时间轴（y=latency，颜色=agent）</div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="timeline-svg">
        {/* y 轴刻度横线 */}
        {ticks.map((t, i) => {
          const y = padT + (1 - t / maxLat) * innerH;
          return (
            <g key={i}>
              <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="#2d3748" strokeWidth={1} />
              <text x={padL - 4} y={y + 4} textAnchor="end" fontSize={10} fill="#4a5568">
                {t >= 10000 ? `${(t / 1000).toFixed(1)}s` : `${Math.round(t)}ms`}
              </text>
            </g>
          );
        })}

        {/* x 轴 baseline */}
        <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="#4a5568" strokeWidth={1} />

        {/* 点 */}
        {calls.map((c, i) => {
          const x = padL + ((c.ts - t0) / tSpan) * innerW;
          const y = padT + (1 - c.latencyMs / maxLat) * innerH;
          return (
            <circle
              key={i}
              cx={x} cy={y} r={6}
              fill={agentColor(c.agent)}
              stroke="#0f1117" strokeWidth={1}
              style={{ cursor: "pointer" }}
              onMouseEnter={() => setHover({ idx: i, x, y })}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}
      </svg>

      {hover && (
        <div className="timeline-hover" style={{ left: `${(hover.x / W) * 100}%` }}>
          <div><strong style={{ color: agentColor(calls[hover.idx].agent) }}>{calls[hover.idx].agent}</strong>
               {calls[hover.idx].attempt > 1 && <span className="attempt-badge">attempt #{calls[hover.idx].attempt}</span>}</div>
          <div>latency: {fmtMs(calls[hover.idx].latencyMs)}</div>
          <div>tokens: {calls[hover.idx].promptTokens} + {calls[hover.idx].completionTokens}</div>
          <div>cost: {fmtCost(calls[hover.idx].costCNY)}</div>
        </div>
      )}
    </div>
  );
}

export interface LatencyStats {
  min: number;
  median: number;
  max: number;
  p50: number;
  p95: number;
}

export interface Stats {
  count: number;
  totalTokens: number;
  totalCostCNY: number;
  latency: LatencyStats;
}

export interface RunMetrics {
  runId: string;
  hasLlmEvents: boolean;
  calls: Array<{
    agent: string;
    ts: number;
    attempt: number;
    latencyMs: number;
    promptTokens: number;
    completionTokens: number;
    costCNY: number;
  }>;
  byAgent: Record<string, Stats>;
  overall: Stats;
}

export interface GlobalMetrics {
  totalRuns: number;
  overall: Stats;
  byAgent: Record<string, Stats>;
}

// 修正 2：count < SAMPLE_THRESHOLD 时，前端只展示 min/median/max，不显示 p50/p95
export const SAMPLE_THRESHOLD = 20;

// agent 名前缀（冒号前）→ 颜色，演示时一眼分清
export function agentColor(agent: string): string {
  const prefix = agent.split(":")[0];
  switch (prefix) {
    case "clarify": return "#f6e05e"; // 黄
    case "plan":    return "#90cdf4"; // 蓝
    case "code":    return "#b794f4"; // 紫
    case "pr":      return "#68d391"; // 绿
    case "script":  return "#a0aec0"; // 灰
    default:        return "#fc8181"; // 红 — 兜底/未识别
  }
}

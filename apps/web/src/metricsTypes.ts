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

export function agentColor(agent: string): string {
  const prefix = agent.split(":")[0];
  switch (prefix) {
    case "clarify": return "#EF9F27";
    case "plan":    return "#7F77DD";
    case "code":    return "#534AB7";
    case "pr":      return "#1D9E75";
    case "script":  return "#AFA9EC";
    default:        return "#D85A30";
  }
}

import { useCallback, useEffect, useState } from "react";

const API = "/api";

export interface RecentRun {
  runId: string;
  rawText: string;
  repoNwo?: string | null;
  repoPath?: string | null;
  status: "running" | "completed" | "cancelled" | "error";
  eventCount: number;
  startedAt: number;
  updatedAt: number;
  lastEventType: string;
}

export function useRecentRuns(refreshSignal: number = 0, limit: number = 20) {
  const [runs, setRuns] = useState<RecentRun[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/runs/recent?limit=${limit}`);
      const data = await res.json() as { runs: RecentRun[] };
      setRuns(data.runs ?? []);
    } finally {
      setLoading(false);
    }
  }, [limit]);

  const deleteRunHistory = useCallback(async (runId: string) => {
    const res = await fetch(`${API}/runs/${runId}`, { method: "DELETE" });
    if (!res.ok) {
      throw new Error("Failed to delete run history");
    }
    await refresh();
  }, [refresh]);

  useEffect(() => { refresh(); }, [refresh, refreshSignal]);

  return { runs, loading, refresh, deleteRunHistory };
}

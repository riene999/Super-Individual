import { useEffect, useState, useCallback } from "react";
import type { GlobalMetrics, RunMetrics } from "./metricsTypes.js";

const API = "/api";

export function useGlobalMetrics(refreshSignal: number = 0) {
  const [data, setData] = useState<GlobalMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/metrics`);
      setData(await res.json() as GlobalMetrics);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData, refreshSignal]);

  return { data, loading, refresh: fetchData };
}

export function useRunMetrics(runId: string | null, refreshSignal: number = 0) {
  const [data, setData] = useState<RunMetrics | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!runId) { setData(null); return; }
    setLoading(true);
    fetch(`${API}/runs/${runId}/metrics`)
      .then(r => r.json())
      .then((d: RunMetrics) => setData(d))
      .finally(() => setLoading(false));
  }, [runId, refreshSignal]);

  return { data, loading };
}

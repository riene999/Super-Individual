import { useState, useCallback, useEffect } from "react";

const API = "/api";

export type RepoStatus = "idle" | "cloning" | "resetting" | "rebuilding" | "ready" | "error";

export interface RepoSpecStatus {
  key: string;
  initialReady: boolean;
  currentReady: boolean;
  fileCount: number;
  initialFileCount: number;
}

export interface RepoState {
  repoUrl: string;
  nwo: string | null;
  status: RepoStatus;
  error: string | null;
  spec: RepoSpecStatus | null;
}

const initial: RepoState = { repoUrl: "", nwo: null, status: "idle", error: null, spec: null };

export function useRepo() {
  const [state, setState] = useState<RepoState>(initial);

  useEffect(() => {
    fetch(`${API}/repos`)
      .then((r) => r.json())
      .then((list: { nwo: string; spec?: RepoSpecStatus }[]) => {
        if (list.length > 0) {
          const { nwo, spec } = list[list.length - 1];
          setState({ repoUrl: `https://github.com/${nwo}`, nwo, status: "ready", error: null, spec: spec ?? null });
        }
      })
      .catch(() => {});
  }, []);

  const setRepoUrl = useCallback((url: string) => {
    setState({ repoUrl: url, nwo: null, status: "idle", error: null, spec: null });
  }, []);

  const cloneRepo = useCallback(async (repoUrl: string) => {
    if (!repoUrl.trim()) return;
    setState((prev) => ({ ...prev, status: "cloning", error: null }));
    try {
      const res = await fetch(`${API}/repos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl: repoUrl.trim() }),
      });
      const data = await res.json() as { nwo?: string; error?: string; spec?: RepoSpecStatus };
      if (!res.ok) throw new Error(data.error ?? "Clone failed");
      setState((prev) => ({ ...prev, nwo: data.nwo ?? null, status: "ready", spec: data.spec ?? null }));
    } catch (e) {
      setState((prev) => ({ ...prev, status: "error", error: String(e) }));
    }
  }, []);

  const resetRepo = useCallback(async (repoUrl: string) => {
    if (!repoUrl.trim()) return;
    setState((prev) => ({ ...prev, status: "resetting", error: null }));
    try {
      const res = await fetch(`${API}/repos/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl: repoUrl.trim() }),
      });
      const data = await res.json() as { nwo?: string; error?: string; spec?: RepoSpecStatus };
      if (!res.ok) throw new Error(data.error ?? "Reset failed");
      setState((prev) => ({ ...prev, nwo: data.nwo ?? prev.nwo, status: "ready", spec: data.spec ?? prev.spec }));
    } catch (e) {
      setState((prev) => ({ ...prev, status: "error", error: String(e) }));
    }
  }, []);

  const rebuildSpec = useCallback(async (repoUrl: string) => {
    if (!repoUrl.trim()) return;
    setState((prev) => ({ ...prev, status: "rebuilding", error: null }));
    try {
      const res = await fetch(`${API}/repos/spec/rebuild`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl: repoUrl.trim() }),
      });
      const data = await res.json() as { error?: string; spec?: RepoSpecStatus };
      if (!res.ok) throw new Error(data.error ?? "Rebuild failed");
      setState((prev) => ({ ...prev, status: "ready", spec: data.spec ?? prev.spec }));
    } catch (e) {
      setState((prev) => ({ ...prev, status: "error", error: String(e) }));
    }
  }, []);

  return { state, setRepoUrl, cloneRepo, resetRepo, rebuildSpec };
}

import { useState, useCallback, useEffect } from "react";

const API = "/api";

export type RepoStatus = "idle" | "cloning" | "ready" | "error";

export interface RepoState {
  repoUrl: string;
  nwo: string | null;
  status: RepoStatus;
  error: string | null;
}

const initial: RepoState = { repoUrl: "", nwo: null, status: "idle", error: null };

export function useRepo() {
  const [state, setState] = useState<RepoState>(initial);

  useEffect(() => {
    fetch(`${API}/repos`)
      .then((r) => r.json())
      .then((list: { nwo: string }[]) => {
        if (list.length > 0) {
          const { nwo } = list[list.length - 1];
          setState({ repoUrl: `https://github.com/${nwo}`, nwo, status: "ready", error: null });
        }
      })
      .catch(() => {});
  }, []);

  const setRepoUrl = useCallback((url: string) => {
    setState({ repoUrl: url, nwo: null, status: "idle", error: null });
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
      const data = await res.json() as { nwo?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Clone failed");
      setState((prev) => ({ ...prev, nwo: data.nwo ?? null, status: "ready" }));
    } catch (e) {
      setState((prev) => ({ ...prev, status: "error", error: String(e) }));
    }
  }, []);

  return { state, setRepoUrl, cloneRepo };
}

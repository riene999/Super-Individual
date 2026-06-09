import { useState, useCallback, useEffect } from "react";

const API = "/api";

export interface Skill {
  name: string;
  content: string;
}

export function useSkills(enabled: boolean) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/skills`);
      const data = await res.json() as { skills: Skill[] };
      setSkills(data.skills ?? []);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) refresh();
  }, [enabled, refresh]);

  const create = useCallback(async (name: string, content: string) => {
    const res = await fetch(`${API}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, content }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.detail?.error ?? data?.error ?? "创建失败");
    await refresh();
  }, [refresh]);

  const update = useCallback(async (name: string, content: string, newName?: string) => {
    const res = await fetch(`${API}/skills/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, newName: newName && newName !== name ? newName : undefined }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.detail?.error ?? data?.error ?? "保存失败");
    await refresh();
  }, [refresh]);

  const remove = useCallback(async (name: string) => {
    const res = await fetch(`${API}/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.detail?.error ?? data?.error ?? "删除失败");
    await refresh();
  }, [refresh]);

  return { skills, loading, error, refresh, create, update, remove };
}

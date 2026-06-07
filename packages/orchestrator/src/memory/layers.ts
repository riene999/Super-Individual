import type { Layer } from "./types.js";

/**
 * 规则推算 affectedLayers：路径前缀是确定性事实，不让 LLM 推。
 *
 * - 含 "models/" 或 "migrations" → "db"
 * - 含 "backend/"                → "backend"
 * - 含 "frontend/"               → "frontend"
 */
export function inferLayers(changedFiles: string[]): Layer[] {
  const set = new Set<Layer>();
  for (const f of changedFiles) {
    const norm = f.replace(/\\/g, "/").toLowerCase();
    if (norm.includes("models/") || norm.includes("migrations")) set.add("db");
    if (norm.startsWith("backend/") || norm.includes("/backend/")) set.add("backend");
    if (norm.startsWith("frontend/") || norm.includes("/frontend/")) set.add("frontend");
  }
  // 输出排序便于断言稳定
  const order: Layer[] = ["db", "backend", "frontend"];
  return order.filter((l) => set.has(l));
}

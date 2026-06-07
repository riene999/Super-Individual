/** 清理 stale fixture，恢复纯真实 memory */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { M_STALE } from "../../../e2e/fixtures/memory-stale.js";

const __filename = fileURLToPath(import.meta.url);
const dir = process.env.MEMORY_DIR ?? join(dirname(__filename), "../../../../memory");
const file = join(dir, "store.jsonl");

if (!existsSync(file)) {
  console.log("memory/store.jsonl 不存在，无需清理");
  process.exit(0);
}

const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
const kept = lines.filter((line) => {
  try { return JSON.parse(line).runId !== M_STALE.runId; } catch { return true; }
});
writeFileSync(file, kept.join("\n") + (kept.length ? "\n" : ""), "utf8");
console.log(`✓ 清理 fixture: ${M_STALE.runId}; 剩余 ${kept.length} 条`);

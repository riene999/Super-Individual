import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { M_FAILED_DEMO } from "../../../e2e/fixtures/memory-failed.js";

const __filename = fileURLToPath(import.meta.url);
const dir = process.env.MEMORY_DIR ?? join(dirname(__filename), "../../../../memory");
const file = join(dir, "store.jsonl");

if (!existsSync(file)) { console.log("no memory file"); process.exit(0); }
const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
const kept = lines.filter((l) => { try { return JSON.parse(l).runId !== M_FAILED_DEMO.runId; } catch { return true; } });
writeFileSync(file, kept.join("\n") + (kept.length ? "\n" : ""), "utf8");
console.log(`✓ 清理 failed fixture: ${M_FAILED_DEMO.runId}; 剩余 ${kept.length} 条`);

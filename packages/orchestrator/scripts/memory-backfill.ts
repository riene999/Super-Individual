/**
 * 对指定 runId 反跑 RequestMemory 抽取，写入 memory/store.jsonl
 *
 * 用法：
 *   tsx scripts/memory-backfill.ts <runId> [<runId>...]
 */
import { createDoubaoClient } from "../src/llm/doubao.js";
import { persistMemory } from "../src/memory/store.js";

const runIds = process.argv.slice(2);
if (runIds.length === 0) {
  console.error("用法: tsx memory-backfill.ts <runId> [<runId>...]");
  process.exit(1);
}

const llm = createDoubaoClient();   // 无 runId 绑定，llm.call 写到 _global.jsonl

for (const runId of runIds) {
  console.log(`\n--- 反跑抽取 runId=${runId} ---`);
  const mem = await persistMemory(runId, llm);
  if (!mem) {
    console.error(`✗ 失败: 无法从 events 重建`);
    continue;
  }
  console.log(`✓ ${mem.skillUsed}  outcome=${mem.outcome}`);
  console.log(`  summary: ${mem.summary}`);
  console.log(`  entities:`, JSON.stringify(mem.entities, null, 2));
  console.log(`  changedFiles: ${mem.changedFiles.join(", ")}`);
  console.log(`  clarifications: ${mem.clarifications.length} 条`);
}

console.log("\n完成。");

/**
 * 临时往 memory/store.jsonl 注入 stale fixture，用于演示 recall.stale 链路。
 * 跑完一次 demo run 后用 remove-stale-fixture.ts 清理。
 */
import { upsertMemory, readAllMemories } from "../src/memory/store.js";
import { M_STALE } from "../../../e2e/fixtures/memory-stale.js";

upsertMemory(M_STALE);
console.log(`✓ 注入 fixture: ${M_STALE.runId}`);
console.log(`当前 memory 总数: ${readAllMemories().length}`);

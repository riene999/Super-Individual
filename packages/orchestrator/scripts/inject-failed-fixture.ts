/**
 * 临时往 memory/store.jsonl 注入一条 failed outcome 的 fixture，用于 RecallCard 截图演示。
 * 清理：tsx scripts/remove-failed-fixture.ts
 */
import { upsertMemory, readAllMemories } from "../src/memory/store.js";
import { M_FAILED_DEMO } from "../../../e2e/fixtures/memory-failed.js";

upsertMemory(M_FAILED_DEMO);
console.log(`✓ 注入 failed fixture: ${M_FAILED_DEMO.runId}`);
console.log(`当前 memory 总数: ${readAllMemories().length}`);

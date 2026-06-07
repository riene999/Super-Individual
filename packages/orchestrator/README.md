# Python Orchestrator

这是 orchestrator 的并行 Python 实现。TypeScript 版本仍然保留，等 Python 版本验证稳定后再决定是否切换。

它保持 `apps/web` 依赖的事件 JSONL 结构和公开 API 契约不变。

当前迁移状态：

- 已实现 skill 路由和通用规划。
- 已按相同阶段边界实现 clarify / aspect scan / locate / code / verify / memory / metrics。
- skill 路径下的 `aspect.scanned` 会按 TS 版规则输出 `all`、`forSkill` 和 breakdown，并继续用 aspect 模板生成澄清问题。

# DEMO 手册

答辩对照表。每一项的格式：**评委想看 X → 你做 Y → 期望看到 Z**。

按顺序走，约 12-15 分钟。

---

## 1. 系统跑得通（基础闭环）

| 评委想看 | 你做 | 期望看到 |
|---|---|---|
| 端到端流水线真跑 | 浏览器输入 `我想在每篇文章卡片上看到大概要读几分钟` | 事件流依次出现 `run.started → clarify.questions → clarify.done → plan.done → locate.done → llm.call×N → code.done → verify.running → verify.done → commit.done → run.completed` |
| Conduit 真改了代码 | 终端 `cd workspace/conduit && git log --oneline -3` | 顶部一条 `feat/readingTime-...` commit，3 文件改动，diff 合理 |
| 测试真通过 | `cd workspace/conduit && npm test -- --run` | `12 passed (12)` |

**讲故事重点**：澄清问题不是写死的，是 LLM 主动问。

---

## 2. WS-1 抽象证明（30% 技术深度）

### 2.1 一个新 Skill 就一个文件

| 评委想看 | 你做 | 期望看到 |
|---|---|---|
| 新模式接入成本到底多低 | `cat packages/orchestrator/src/skills/add-field.skill.ts` | 34 行，纯声明：name + description + matchWords + buildSteps 3 项 |
| 共享脚手架是否过度抽象 | `cat packages/orchestrator/src/skills/base.ts` | 201 行：`defineSkill` 工厂 + `defaultLocate/defaultGenerate` 通用算法 + `LocateError` 强类型错误 |
| 三个 skill 真互不耦合 | `wc -l packages/orchestrator/src/skills/*.skill.ts` | 34 / 39 / 58，全部 < 80 行硬指标 |

**话术**：「现场出题：'给文章加点赞数排序'——属于 add-filter 范畴，新写 ~45 行；'新增分类管理后台页'——属于 add-page，~60 行。」

### 2.2 弱耦合

| 评委想看 | 你做 | 期望看到 |
|---|---|---|
| 删一个文件别的真没事 | `pnpm test:weak-coupling` | 禁用 add-filter.skill.ts → 仅 add-field 和 add-page 加载 → 它们仍正常 → 恢复 → 回到 3 个 |

### 2.3 PlanAgent 路由：keyword 快路径 + LLM 兜底

| 评委想看 | 你做 | 期望看到 |
|---|---|---|
| 不是关键词硬编 | 浏览器输入 `给文章卡片新增字段显示阅读时长，并提供按阅读时长筛选` | `plan.done` 卡片显示：`by=llm-router`，候选评分 `add-field=1.0 / add-filter=1.0 / add-page=0`，LLM 选型理由附在下方 |
| 简单需求不浪费 LLM | 输入纯 add-field 需求 | `plan.done` 卡片显示 `by=keyword`，候选评分中 add-field 一骑绝尘 |
| 确定性测试覆盖路由决策 | `pnpm test:skills` | `--- 路由决策快路径验证 ---` 三 case 全过 |

**话术**：「keyword 快路径不调 LLM，零成本，可被确定性测试覆盖。两个 skill 拉锯（gap < 0.3）或都没把握（top1 < 0.5）才调 LLM 仲裁。事件流里 by 字段标记决策路径，全程可追溯。」

---

## 3. WS-2 可观测面板（25% 工程完整度）

### 3.1 全局指标 tab

| 评委想看 | 你做 | 期望看到 |
|---|---|---|
| token/时延/成本监控 | 切到"全局指标" tab | KPI 5 个：总调用 / 总 tokens / 总成本 ¥ / latency 中位 / latency 最大 |
| 按 agent 分摊 | 看下方横条 | 按总成本降序：`code:add-field` 最长（多文件），`clarify:*` 黄、`pr:description` 绿、`script:ping-llm` 灰 |
| 样本量诚实 | 看顶上黄色提示横条 | "样本数 N < 20，分位数不可靠，展示中位/最大替代" |

### 3.2 当前 run 指标卡

| 评委想看 | 你做 | 期望看到 |
|---|---|---|
| 时间轴讲故事 | 跑完 run，事件流下方的卡片，鼠标 hover 时间轴点 | 浮窗显示 `agent · attempt · tokens · cost`，颜色按 agent 区分 |
| 重试可观测（修正 1） | 触发 verify 失败重试（需要构造一个会失败的需求） | 时间轴上有 `attempt #2` 的点，金色 badge |
| 旧 run 空态（修正 4） | 选一个 WS-2 之前的 runId | "无指标数据 (本次升级前的 run)"，不是 0 calls / ¥0.00 |

### 3.3 强类型守门

| 评委想看 | 你做 | 期望看到 |
|---|---|---|
| 不会有 agent 漏标 | `cat packages/orchestrator/src/llm/doubao.ts` 看 `ChatMeta` | `agent: string` 必填，没有 `?`，TypeScript 编译期暴露所有调用点 |

**话术**：「ChatMeta.agent 必填，没有 `agent: "unknown"` 默认值。某个调用点忘了打标，TypeScript 编译就过不去——面板上不会出现来路不明的桶。」

---

## 4. WS-3 业务上下文反哺（30% 技术深度 - 超越 RAG）

### 4.1 entities 抽取 + 结构化召回（不是 RAG 切片）

| 评委想看 | 你做 | 期望看到 |
|---|---|---|
| entities 真有区分度 | `pnpm test:memory-discrimination` | 6 配对全过（跨 skill ≤ 0.4-0.5，自相似 = 1.0）|
| 召回打分透明 | `cat memory/store.jsonl` | 每条 RequestMemory 含 `entities` 结构化字段，**不是关键词 grep** |
| 维度命中有说服力 | 跑同 skill 重复需求，看 RecallCard | "主要因为: 同样的操作类型" 突出，"也涉及: article" 次因 |

### 4.2 ClarifyBox 预填三态

| 评委想看 | 你做 | 期望看到 |
|---|---|---|
| aspect 标签机制 | `cat packages/orchestrator/src/skills/add-field.skill.ts` | `possibleAspects: ["field-name","field-type","display-position","calculation-rule"]` |
| 完全匹配预填 | 跑两次同需求 | 第二次 ClarifyBox 输入框预填，右侧紫色"上次答的"标签 |
| 部分匹配提示 | 跑相似但不同需求 | 输入框空，下方黄色 "💡 上次类似问题答过：…" |
| PM 一键拒绝 | RecallCard 点"忽略此条历史" | 事件流出 `recall.dismissed`，预填消失 |

### 4.3 stale 路径检测 + 自然 attempt #2

| 评委想看 | 你做 | 期望看到 |
|---|---|---|
| 召回缓存失效检测 | 跑 stale fixture（含失效路径的 fixture） | 事件流：`recall.matched → recall.stale → locate.done(attempt=2)` |
| `data-failed` DOM 标记 | DevTools 找 failed RecallCard | `<div class="recall-entry recall-failed" data-failed="true">` |

### 4.4 召回前后对比（诚实数字）

| 评委想看 | 你做 | 期望看到 |
|---|---|---|
| 召回真的省 token 吗？ | "全局指标" tab → BaselineCompareCard | **不省** — token +10%, latency +20%, cost +10% |
| 那召回有啥用？ | 同卡片下方"诚实声明"段 | 三条价值：PM 预填体验、stale 防错、跨 run 连贯，**都不在 LLM 数字里** |

**话术**：「我们不装。召回多花了 1 次 LLM 调用 — 数字摆在这。但召回带来的是 PM 视角的体验改善：输入框预填、stale 检测防错、上次怎么答的连贯感。如果一定要让召回也省 token，下一档会让 ClarifyAgent 直接跳过同 aspect 已答过的问题生成 — 那是 WS-4 的事。」

---

## 5. 工程基本功

| 评委想看 | 你做 | 期望看到 |
|---|---|---|
| 集成测试绿 | `pnpm test:all` | 双轨回归：deterministic + weak-coupling 全过 |
| 事件溯源 | `cat events/<runId>.jsonl \| head -3` | 每行一条 JSON event，含 `type/runId/ts/payload`，可重放 |
| 重放真能改写下游 | 任意 run 完成后，点重放栏选某事件、改需求文本、点"重放" | 事件流从该点截断，后续按新输入重跑 |

---

## 6. 时序与 5 分钟现场出题

最后留 5 分钟让评委挑一项现场跑：

| 出题 | 你的判断 | 行数估算 |
|---|---|---|
| "给文章加点赞数排序" | add-filter 范畴（按字段排序也是过滤的一种） | ~45 行 |
| "新增热门作者榜页面" | add-page，与 popularTags 同模式 | ~60 行 |
| "在文章详情页显示作者粉丝数" | add-field（单条数据多展示一个字段） | ~35 行 |
| "把整个 UI 改成暗黑模式" | ❌ 不是字段/筛选/页面三类，应**拒绝**而不是硬塞 | — |

**收尾话术**：「现有三个 skill 不是穷尽——它们是声明式抽象的样本。新模式来了，看是不是这三类的变体：是 → 加文件；不是 → 拒绝硬塞，可以新写一个 skill 模式，但仍是一个文件、~60 行的规模。」

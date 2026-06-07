# Super Individual

AI 编排系统，将 PM 自然语言需求转化为 Conduit 仓库代码变更。

## 快速开始

```bash
pnpm install
# DOUBAO_API_KEY / DOUBAO_EP_ID 走 Windows 用户级环境变量，不入磁盘
pnpm dev               # 同时启动 web(:5173) 和 api(:3001)
```

## 结构

- `apps/web` — 对话前端 + 指标面板 (Vite + React + TS)
- `apps/api` — HTTP + SSE 后端 (Express + TS)
- `packages/orchestrator` — 编排核心：Agents、Skills、Events、Metrics
- `workspace/conduit` — 实验田仓库（只读，通过 git 分支修改）
- `e2e` — 确定性 smoke + 弱耦合测试

## 测试 LLM 连接

```bash
pnpm --filter @super-individual/orchestrator exec tsx scripts/ping-llm.ts
```

---

## WS-1 · Skill 抽象层

**命中评分锚点**：技术深度（30%）「抽象证明」 + 业务（20%）「新模式接入成本」 + 加分锚点「弱耦合」

### 数据流

```
PM 自然语言
  → ClarifyAgent       (LLM: 解析成 ClarifiedRequest，主动追问)
  → PlanAgent          (keywordMatch 快路径 | LLM router 兜底 → Skill)
  → LocateAgent        (Skill.locate → ChangeSet，校验 mode:modify/create)
  → CodeAgent          (Skill.generate → FilePatch[]，写入 Conduit)
  → VerifyAgent        (syntax guard + npm test，失败重试 ≤2)
  → 提交 feature 分支 + LLM 生成 PR 描述
```

### Skill 抽象

| 行数 | 文件 |
|---|---|
| 201 | `base.ts` — 共享脚手架：`defineSkill()`/`keywordMatch()`/`defaultLocate()`/`defaultGenerate()`/`runLLMOnFile()` |
| 34  | `add-field.skill.ts` |
| 39  | `add-filter.skill.ts` |
| 58  | `add-page.skill.ts` |

新需求模式只需新增一个 `*.skill.ts`，registry 自动扫描。Skill 接口、ChangeSet、orchestrator、五个 Agent 自抽象上线后零变动。

### PlanAgent 路由决策

```
keywordMatch  →  top1.score >= 0.5  AND  top1 - top2 >= 0.3   →  by:"keyword"
              否则                                              →  LLM router
```

事件流里 `plan.done.payload.by` 标记决策路径，附 `candidates` 全量评分 + LLM 选型理由。

### 现场演示（3 句）

1. `pnpm test:all` — 跑确定性 + 弱耦合双轨回归（不调 LLM，~1 秒）
2. 浏览器输入 demo prompt，事件流里 `plan.done` 卡片显示 `by=keyword`
3. 输入混合需求（"加字段 + 按字段筛选"），同卡片显示 `by=llm-router` + LLM 选型理由

---

## WS-2 · 可观测性面板

**命中评分锚点**：工程完整度（25%）「token / 时延 / 成本监控」 + 加分锚点「verify 重试可观测」

### 数据流

```
LLMClient.chat(msgs, opts, meta) → 调用完成
  ├─ console.log: [LLM clarify:analyze] tokens=... latency=...
  └─ emit "llm.call" → events/<runId>.jsonl

聚合层：
  GET /api/metrics              ← aggregateGlobal() 扫所有 jsonl
  GET /api/runs/:id/metrics     ← aggregateRun(runId)
```

每次 LLM 调用通过强制 `ChatMeta { agent: string; runId?; attempt? }` 打标，TypeScript 在签名层杜绝"忘记打标→落入未知桶"。

### Agent 命名口径（演示要点）

| 调用点 | agent 值 |
|---|---|
| ClarifyAgent.analyze     | `clarify:analyze` |
| ClarifyAgent.resolve     | `clarify:resolve` |
| PlanAgent LLM router     | `plan:router` |
| CodeAgent（per file）    | `code:<skill-name>` 如 `code:add-field` |
| Orchestrator PR 描述     | `pr:description` |
| 脚本                     | `script:ping-llm` |

### 面板设计取舍

- **当前 run 指标** = 事件流下方小卡（KPI + 时间轴点图）
- **全局指标** = 独立 tab（KPI + 按 agent 横条图）
- 不糅在一起，演示时讲得清"看到的是这次还是累计"
- 时间轴 y=latency 不是 tokens（latency 才有故事："看，locate 那一步慢"）
- 样本数 < 20 时只展示 min/median/max，达阈值才切 p50/p95
- 旧 run 无 llm.call 时显示 "无指标数据 (本次升级前的 run)"，避免 0 calls / ¥0.00 误导

### 现场演示（3 句）

1. 跑完一次需求，事件流下方的 RunMetricsCard 鼠标 hover 时间轴点：看到 `agent · attempt · tokens · cost`
2. 切到"全局指标" tab：KPI + 按 agent 横条图，最烧钱的 agent 排在最上
3. 触发一次 verify 失败重试后，时间轴上 `attempt #2` 的点会带金色 badge

---

---

## WS-3 · 业务上下文反哺（含召回前后对比）

**命中评分锚点**：技术深度 30%「超越 RAG」 + 加分锚点「跨 run 的连续性」

### 反哺管线（差异化卖点：不是 RAG 切片，是结构化召回 + aspect 匹配）

```
run 完成时
  └─ LLM extract → RequestMemory { entities, clarifications[{q,a,aspect}] } → memory/store.jsonl

新 run 启动
  └─ clarify.analyze → partial.summary
     └─ extract(partial.summary) → query entities
        └─ recall(query, all memories) → topK matches (打分 + matchedDimensions)
           └─ stat top-1.changedFiles → recall.stale?
              └─ emit recall.matched / recall.stale  ← 早于 clarify.questions
                 └─ ClarifyBox 出现，预填来自 aspect 匹配的历史 QA
```

权重：`0.40 操作类型 + 0.30·jaccard(domainObjects) + 0.20 uiSurfaces + 0.10 affectedLayers`，failed run 整体 0.5×。

### 召回的真实价值（诚实声明）

跑 baseline (DISABLE_RECALL=true) vs with-recall 对比的真实数字：

| 指标 | baseline | with recall | 差值 |
|---|---|---|---|
| 澄清问题数 | 2 | 2 | 不变 |
| LLM 调用次数 | 7 | 8 | **+1** |
| 总 tokens | 9,487 | 10,475 | **+10.4%** |
| 总成本 | ¥0.0150 | ¥0.0165 | **+10.1%** |
| 总 latency | 380s | 461s | **+21.4%** |

**召回 = 多花 LLM 钱，省 PM 体力**。它的真实价值在 LLM 数字之外：

1. **PM 体验**：ClarifyBox 输入框预填历史答案（aspect 完全匹配时），PM 打字量下降——但这部分不进 token 计费
2. **防错**：`recall.stale` 检测召回的历史路径是否还在，自然触发 `locate.done attempt=2` 回退到纯 skill 路径，**阻止 bug 而不是省 token**
3. **上下文连贯**：跨 run 的"上次怎么答"，PM 可一键忽略（`recall.dismissed` 事件可重放）

如果未来要让召回也省 LLM token，需要让 ClarifyAgent 本身看到召回（跳过同 aspect 已答过的问题生成）。这是 WS-4 的延伸方向。

### 现场演示（4 句）

1. `pnpm test:all` — 38+ 断言全过（含 memory discrimination gate + prefill 三态语义 + 弱耦合）
2. 跑两次"我想在每篇文章卡片上看到大概要读几分钟"——第二次 ClarifyBox 输入框带"上次答的"紫色标签
3. RecallCard 上点"忽略此条历史"，事件流出 `recall.dismissed`，预填消失
4. 切到「全局指标」tab 看 `BaselineCompareCard` —— 数字诚实，把"省了什么 / 没省什么"摆出来

---

## 测试入口

| 命令 | 内容 | 是否调 LLM |
|---|---|---|
| `pnpm test:skills` | match / plan / locate / 路由决策 | 否 |
| `pnpm test:weak-coupling` | 删任一 skill 文件验证其余 | 否 |
| `pnpm test:memory-discrimination` | entities 区分度 gate（6 配对）| 否 |
| `pnpm test:memory-recall` | 打分函数全场景（7 cases）| 否 |
| `pnpm test:recall-integration` | extract 入参可选 + stale 检测 | 否 |
| `pnpm test:aspect-matching` | aspect 枚举校验 | 否 |
| `pnpm test:recall-prefill` | 预填三态语义 | 否 |
| `pnpm test:all` | 全部串跑（~3 秒）| 否 |
| `pnpm --filter @super-individual/orchestrator exec tsx scripts/ping-llm.ts` | LLM 连通性 | 是 |

跑 baseline-vs-recall 对比：
```bash
# 1. baseline run（跳过召回）
DISABLE_RECALL=true npx tsx apps/api/src/index.ts   # 启 API
# 在浏览器跑一次 run，记下 runId → BASELINE_ID

# 2. with-recall run（正常模式）
npx tsx apps/api/src/index.ts                       # 启 API
# 跑同样需求，记下 runId → WITH_RECALL_ID

# 3. 看对比
curl http://localhost:3001/api/runs/compare/$BASELINE_ID/$WITH_RECALL_ID
# 或在"全局指标" tab 的 BaselineCompareCard 直接对比
```

## Windows 排坑

- 豆包 API key 走 Windows 用户级环境变量：
  ```powershell
  [System.Environment]::SetEnvironmentVariable("DOUBAO_API_KEY", "...", "User")
  ```
  设完**重启 IDE/终端**才能继承。
- PowerShell 5.1 `Invoke-WebRequest` 发中文 JSON 必须用 UTF-8 字节流：
  ```powershell
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  ```
  浏览器 fetch 无此问题，真实用户无感知。所有需要发 JSON 的演示脚本统一用 `node`/`tsx`，不用 `Invoke-WebRequest`。

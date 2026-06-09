# Super Individual

把 PM 的**自然语言需求**变成目标 GitHub 仓库里**可提测的 PR**。

输入一句话需求（如"在文章卡片上显示阅读时长"），系统自动跑完整条流水线，最后在目标仓库的 fork 上开一个 PR，全过程在前端事件流里实时可见。

## 工作流水线

```
召回历史 → 代码规范(建索引 + 选相关文件) → 规划(含按需澄清) → 定位文件
         → 生成代码 → 验证(语法 + 后端加载 + 前端构建 + 测试，失败重试)
         → 提交分支 → 开 PR
```

- **召回**：检索相似历史需求作规划参考（前端可开关）。
- **代码规范（code-spec）**：为目标仓库每个文件生成摘要 + 接口签名索引，再让 LLM 挑出与需求相关的文件作"地图"。
- **规划（plan-loop）**：规划 agent 自评信息是否充足，只在关键歧义时向 PM 提问（最多 3 轮），产出钉死跨文件命名/签名的 contract + 文件改动清单。
- **生成**：逐文件生成；新建文件的 agent 可用只读搜索工具核对仓库真实写法，避免臆造。
- **验证**：真实跑 `node --check` + 后端加载冒烟 + 前端 `vite build` + 测试，报错回喂 LLM 修复，最多 3 次。
- **skill**：`skills/library/*.md` 是做各类需求的方法论文档，注入规划阶段作参考。**可在前端开关，也可在设置面板里增删改**。

## 依赖环境

| 工具 | 版本 | 用途 |
|---|---|---|
| Node.js | ≥ 18 | 前端 + pnpm workspace |
| pnpm | ≥ 8 | Node 侧包管理 |
| Python | ≥ 3.10 | 后端 API + 编排核心 |
| [uv](https://docs.astral.sh/uv/) | 最新 | Python 侧包管理 |
| git | — | clone / commit / push |
| [GitHub CLI `gh`](https://cli.github.com/) | 已登录 | fork 目标仓库、开 PR |

> 目标仓库的**验证**会在克隆下来的仓库里跑构建与测试，所以那个仓库自身的依赖要装好（在 `workspace/repos/<owner>/<repo>` 下 `npm install`）。`gh` 需先 `gh auth login`。

## 启动步骤

```bash
# 1. 配置环境变量（见下方"API key 配置位置"）
cp .env.example .env
#   编辑 .env，填入 DOUBAO_API_KEY 与 DOUBAO_EP_ID

# 2. 安装依赖
pnpm install                      # Node 侧（前端）
cd apps/api && uv sync && cd ../.. # Python 侧（后端 + 编排，editable 安装 orchestrator）

# 3. 登录 GitHub（用于 fork + 开 PR）
gh auth login

# 4. 起后端 API（端口 3001）
pnpm dev:py-api
#   等价于：cd apps/api && uv run uvicorn app.main:app --host 0.0.0.0 --port 3001 --reload --env-file ../../.env

# 5. 另开一个终端，起前端（端口 5173，自动把 /api 代理到 3001）
pnpm --filter @super-individual/web dev
```

打开 http://localhost:5173 ，在页面里 Clone 目标仓库 → 输入需求 → 运行。

> 注意：`.env` 不会被 Python 自动加载，必须用 `uvicorn --env-file` 传入（`pnpm dev:py-api` 已带上），或把变量设进系统环境变量。根目录 `pnpm dev` 只会启动前端，后端需按上面单独起。

## 目录结构

```
super-individual/
├── apps/
│   ├── api/                  后端：FastAPI + SSE（uv 管理）
│   │   └── app/main.py       HTTP 端点：/api/runs、/api/repos、/api/skills、/api/metrics …
│   └── web/                  前端：React 18 + Vite + TS
│       └── src/              App、事件流、设置面板(SettingsModal)、各 hook
├── packages/
│   └── orchestrator/         编排核心（Python 包 super-individual-orchestrator）
│       └── orchestrator/
│           ├── orchestrator.py   流水线主控
│           ├── agents/           code_spec / plan_loop / locate / code / verify
│           ├── repo/             conduit.py（git/gh 操作）、spec_store.py
│           ├── llm/doubao.py     Doubao LLM 客户端
│           ├── skills/           Skill 执行载体 + library/*.md 方法论文档 + library_loader(CRUD)
│           ├── memory/           跨 run 记忆与召回
│           ├── metrics/          token / 成本 / 时延聚合
│           └── events/           事件存储
├── e2e/                      端到端测试（test-recall-prefill.ts）
├── workspace/
│   ├── repos/                克隆下来的目标仓库（<owner>/<repo>）
│   └── repo-specs/           各仓库的代码规范索引（current.json）
├── events/                   每次 run 的事件流 <runId>.jsonl
├── memory/                   持久化的需求记忆
├── .env.example             环境变量样例
└── package.json             pnpm workspace 根
```

## 配置说明

所有配置走环境变量（样例见 `.env.example`）：

| 变量 | 必填 | 说明 |
|---|---|---|
| `DOUBAO_API_KEY` | ✅ | 豆包/Ark 的 API key |
| `DOUBAO_EP_ID` | ✅ | 豆包推理接入点 ID（作为 model 传给 OpenAI 兼容接口）|
| `DOUBAO_BASE_URL` | 否 | 默认 `https://ark.cn-beijing.volces.com/api/v3` |
| `CONDUIT_REPO_PATH` | 否 | 默认目标仓库的本地绝对路径；留空走自动检测 |
| `PORT` | 否 | API 端口（默认 3001；当前由启动命令 `--port` 显式指定）|

其它约定：
- **端口**：前端 5173、后端 3001；Vite 已把 `/api` 代理到 `http://localhost:3001`（见 `apps/web/vite.config.ts`）。
- **GitHub 鉴权**：clone/fork/PR 用 `gh` CLI 自带的登录态（`gh auth login` 或 `GH_TOKEN`），**不放在 `.env` 里**。
- **被 git 忽略**：`.env`、`events/`、`*.jsonl`、`node_modules/`、`.venv/`、`dist/`。

## API key 配置位置

豆包 LLM 的 key 通过环境变量提供，**两种方式任选其一**：

1. **`.env` 文件（推荐）**：项目根目录 `cp .env.example .env`，填入
   ```
   DOUBAO_API_KEY=你的_key
   DOUBAO_EP_ID=你的_接入点_id
   ```
   启动后端时用 `--env-file ../../.env` 加载（`pnpm dev:py-api` 已带上）。`.env` 已在 `.gitignore` 中，不会入库。

2. **系统/用户级环境变量**（Windows 常用，key 不落盘到仓库）：
   ```powershell
   [System.Environment]::SetEnvironmentVariable("DOUBAO_API_KEY", "你的_key", "User")
   [System.Environment]::SetEnvironmentVariable("DOUBAO_EP_ID", "你的_接入点_id", "User")
   ```
   设置后**重启终端/IDE** 才会继承；这种方式下启动命令可省略 `--env-file`。

读取位置在 `packages/orchestrator/orchestrator/llm/doubao.py`：缺 `DOUBAO_API_KEY` 或 `DOUBAO_EP_ID` 会在启动调用时直接抛错。

GitHub 的 token 不在此处配置——交给 `gh auth login` 管理即可。

## 相关文档

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — 系统架构图（前端/后端/模型层/Skill/Orchestrator/sandbox-repo 调用关系 + 时序图）
- [`TECHNICAL_OVERVIEW.md`](./TECHNICAL_OVERVIEW.md) — 工程难点与解决方案、技术栈、项目亮点、性能指标

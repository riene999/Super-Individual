# Architecture

Super Individual 把 PM 的自然语言需求转成目标仓库的可提测 PR。下面是各层与调用关系。

## 总览图

```mermaid
flowchart TB
    subgraph FE["前端 (apps/web · React + Vite)"]
        UI["App / 事件流 / ClarifyBox"]
        SET["SettingsModal · 设置面板"]
        HOOKS["hooks: useRun(SSE) · useRepo · useSkills"]
    end

    subgraph BE["后端 (apps/api · FastAPI + SSE)"]
        API["main.py 端点<br/>/api/runs · /runs/:id/stream<br/>/api/repos · /api/skills · /api/metrics"]
    end

    subgraph ORCH["Orchestrator (packages/orchestrator)"]
        PIPE["orchestrator.py · 流水线主控"]
        subgraph AGENTS["Agents"]
            CS["code_spec<br/>建索引 + 选相关文件"]
            PL["plan_loop<br/>规划 + 按需澄清"]
            LOC["locate"]
            CODE["code · 生成补丁"]
            VER["verify · 真实跑构建/测试"]
        end
        BUS["events bus + store<br/>(events/*.jsonl)"]
        MEM["memory · 召回/记忆"]
    end

    subgraph SKILL["Skill 注册表 (skills/)"]
        LOADER["library_loader<br/>load_skill_docs() + CRUD + 缓存"]
        DOCS[("library/*.md<br/>方法论文档")]
        BASE["base.py · Skill 执行载体<br/>(generic_skill)"]
    end

    subgraph MODEL["模型层 (llm/doubao.py)"]
        LLM["LLMClient.chat()<br/>Doubao / Ark (OpenAI 兼容)"]
    end

    subgraph SANDBOX["sandbox-repo (workspace/)"]
        REPO[("repos/&lt;owner&gt;/&lt;repo&gt;<br/>克隆的目标仓库")]
        SPEC[("repo-specs/&lt;nwo&gt;/current.json<br/>代码规范索引")]
        CONDUIT["repo/conduit.py<br/>git / gh / verify 执行器"]
    end

    GH(["GitHub<br/>fork · push · PR"])

    %% 前后端
    HOOKS -- "HTTP POST /runs" --> API
    API -- "SSE 事件流" --> HOOKS
    SET -- "CRUD /api/skills" --> API

    %% 后端 → 编排
    API --> PIPE
    API -- "skill CRUD / spec rebuild" --> LOADER

    %% 流水线 → agents
    PIPE --> CS & PL & LOC & CODE & VER
    PIPE --> MEM
    PIPE -- "emit 阶段事件" --> BUS
    BUS -- "订阅推送" --> API

    %% skill 注入规划
    LOADER --> DOCS
    PL -- "load_skill_docs() 注入" --> LOADER
    PIPE -- "generic_skill.locate/generate" --> BASE
    BASE --> LOC & CODE

    %% agents → 模型层
    CS & PL & CODE & MEM -- "chat()" --> LLM

    %% agents → sandbox
    CS -- "读文件 / 写索引" --> SPEC
    CS -- "读源码" --> REPO
    LOC -- "读目标文件" --> REPO
    CODE -- "apply_patches 写入" --> REPO
    VER -- "node --check / vite build / npm test" --> REPO
    PIPE -- "clone/commit/branch/push/PR" --> CONDUIT
    CONDUIT --> REPO
    CONDUIT --> GH
```

## 各层职责

| 层 | 位置 | 职责 |
|---|---|---|
| **前端** | `apps/web` | React + Vite。提交需求、实时看事件流(SSE)、回答澄清、管理目标仓库与 skill(设置面板)。Vite 把 `/api` 代理到后端 3001。 |
| **后端** | `apps/api/app/main.py` | FastAPI。HTTP 端点 + SSE 流;把请求转交 Orchestrator,把事件总线推给前端;skill 的增删改查直接落到 `library_loader`。 |
| **Orchestrator** | `packages/orchestrator/orchestrator.py` | 流水线主控:按阶段串起各 agent,发阶段事件,管召回与记忆。 |
| **模型层** | `llm/doubao.py` | `LLMClient.chat()`,Doubao/Ark 的 OpenAI 兼容封装。被 code_spec / plan_loop / code / memory 调用;计 token 与成本。 |
| **Skill 注册表** | `skills/` | `library/*.md` 是做各类需求的方法论文档;`library_loader` 负责加载(带缓存)+CRUD;`base.py` 的 `generic_skill` 是 locate/generate 的执行载体(规划本身已交给 plan_loop)。 |
| **sandbox-repo** | `workspace/` | 克隆下来的目标仓库(`repos/`)、其代码规范索引(`repo-specs/`),以及对它做 git/gh/验证操作的 `conduit.py`。所有代码改动只发生在这里。 |

## 一次 run 的调用时序

```mermaid
sequenceDiagram
    participant U as 前端
    participant A as FastAPI
    participant O as Orchestrator
    participant M as 模型层
    participant S as Skill 注册表
    participant R as sandbox-repo
    participant G as GitHub

    U->>A: POST /api/runs (需求 + 开关)
    A->>O: start_run()
    U->>A: GET /runs/:id/stream (SSE 订阅)

    O->>O: 召回相似历史需求 (可关)
    O->>M: code_spec 摘要 + 选相关文件
    O->>R: 读源码 / 写 repo-specs 索引
    O->>S: load_skill_docs() (可关)
    O->>M: plan_loop 规划
    alt 关键歧义
        O-->>U: clarify.questions (SSE)
        U-->>O: 提交答案
    end
    O->>R: locate 读目标文件
    O->>M: code 生成补丁
    O->>R: 写入补丁
    loop 验证失败重试 ≤3
        O->>R: node --check / vite build / npm test
        O->>M: 报错回喂 LLM 修复
    end
    O->>R: 提交到新分支
    O->>G: push + 开 PR
    O-->>U: commit.done (PR 链接) / run.completed (SSE)
```

## 关键调用关系（一句话版）

- **前端 ↔ 后端**:请求走 HTTP `POST /api/runs`,进度走 SSE `GET /api/runs/:id/stream`;设置面板的 skill 增删改走 `/api/skills`。
- **后端 → Orchestrator**:`main.py` 调 `start_run()` 起流水线;事件总线(`events bus`)反向推回 SSE。
- **Orchestrator → 模型层**:code_spec / plan_loop / code / memory 通过 `LLMClient.chat()` 调 Doubao。
- **plan_loop ← Skill 注册表**:规划阶段 `load_skill_docs()` 把方法论文档注入提示词(可被前端 skill 开关跳过)。设置面板的 CRUD 经 `library_loader` 改 `.md` 并清缓存,下一次 run 即时生效。
- **Orchestrator/Agents → sandbox-repo**:code_spec 读源码并写规范索引,locate 读目标文件,code 写补丁,verify 在仓库里真实跑构建与测试;`conduit.py` 负责 clone/commit/branch/push,并用 `gh` fork 与开 PR。

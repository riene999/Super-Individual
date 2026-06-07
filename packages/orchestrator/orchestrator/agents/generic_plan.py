from __future__ import annotations

import json
from pathlib import Path

from orchestrator.llm.doubao import LLMClient
from orchestrator.skills.base import Skill, default_generate, default_locate
from orchestrator.types import ClarifiedRequest, FileStep, RepoContext, SkillPlan

MAX_GENERIC_FILES = 6


def _list_dir(root: Path, relative: str, depth: int) -> list[str]:
    path = root / relative
    if not path.exists() or depth < 0:
        return []
    out: list[str] = []
    for child in sorted(path.iterdir(), key=lambda p: p.name):
        if child.name in {"node_modules", ".git", "dist", "build"}:
            continue
        rel = str(child.relative_to(root)).replace("\\", "/")
        out.append(rel + "/" if child.is_dir() else rel)
        if child.is_dir():
            out.extend(_list_dir(root, rel, depth - 1))
    return out


def _safe_read(root: Path, relative: str) -> str:
    path = root / relative
    if not path.exists():
        return "(文件不存在)"
    return "\n".join(path.read_text(encoding="utf-8", errors="ignore").splitlines()[:180])


def _list_files(root: Path, relative: str) -> list[str]:
    path = root / relative
    if not path.exists():
        return []
    return sorted(str(p.relative_to(root)).replace("\\", "/") for p in path.iterdir() if p.is_file())


def get_repo_overview(ctx: RepoContext) -> str:
    root = Path(ctx.repoPath)
    return "\n".join(
        [
            f"仓库路径：{root}",
            f"当前分支：{ctx.branch}",
            "--- 目录树（最多 2 层）---",
            "\n".join(_list_dir(root, "", 2)[:220]),
            "--- 前端入口文件 ---",
            f"--- frontend/src/App.jsx ---\n{_safe_read(root, 'frontend/src/App.jsx')}",
            f"--- frontend/src/main.jsx ---\n{_safe_read(root, 'frontend/src/main.jsx')}",
            "--- 前端页面文件 ---",
            "\n".join(_list_files(root, "frontend/src/routes")),
            "\n".join(_list_files(root, "frontend/src/routes/Profile")),
            "--- 后端路由注册 ---",
            _safe_read(root, "backend/index.js"),
            "--- 后端路由文件 ---",
            "\n".join(_list_files(root, "backend/routes")),
            "--- 后端模型文件 ---",
            "\n".join(_list_files(root, "backend/models")),
        ]
    )


def _clean_json(text: str) -> str:
    s = text.strip()
    if s.startswith("```"):
        s = s.split("\n", 1)[1] if "\n" in s else s
        if s.endswith("```"):
            s = s[:-3]
    return s.strip()


def parse_plan(text: str) -> list[FileStep]:
    cleaned = _clean_json(text)
    try:
        data = json.loads(cleaned)
    except Exception:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start < 0 or end <= start:
            raise
        data = json.loads(cleaned[start : end + 1])
    files = data.get("files")
    if not isinstance(files, list):
        raise ValueError("genericPlan 没有返回 files 数组")
    steps: list[FileStep] = []
    for i, f in enumerate(files[:MAX_GENERIC_FILES]):
        path = str(f.get("path", "")).strip()
        mode = f.get("mode")
        instruction = str(f.get("instruction", "")).strip()
        if not path:
            raise ValueError(f"genericPlan.files[{i}] 缺少 path")
        if mode not in {"modify", "create"}:
            raise ValueError(f"genericPlan.files[{i}] mode 必须是 modify 或 create")
        if not instruction:
            raise ValueError(f"genericPlan.files[{i}] 缺少 instruction")
        steps.append(FileStep(path=path, mode=mode, instruction=instruction))
    return steps


def _fallback_plan(req: ClarifiedRequest, ctx: RepoContext) -> SkillPlan:
    haystack = " ".join([req.summary, req.fieldName, req.businessRule, req.displayLocation]).lower()
    root = Path(ctx.repoPath)
    if any(x in haystack for x in ("comment", "comments", "评论")) and any(x in haystack for x in ("like", "likes", "点赞")):
        candidates = [
            FileStep(
                path="backend/models/Comment.js",
                mode="modify",
                instruction=f"Add `{req.fieldName}` support for comments as a non-negative integer derived from idempotent comment likes.",
            ),
            FileStep(
                path="backend/controllers/comments.js",
                mode="modify",
                instruction="Add idempotent comment like handling so the same user can only count once per comment, and return likeCount with comments.",
            ),
            FileStep(
                path="backend/routes/articles/comments.js",
                mode="modify",
                instruction="Add authenticated routes for liking or unliking a comment under an article comment URL.",
            ),
            FileStep(
                path="frontend/src/components/CommentList/CommentList.jsx",
                mode="modify",
                instruction=f"Show `{req.fieldName}` beside the comment like button and keep the UI count idempotent after repeated likes.",
            ),
            FileStep(
                path="frontend/src/services/toggleCommentLike.js",
                mode="create",
                instruction="Create a service for toggling comment likes through the backend comment-like endpoint.",
            ),
        ]
        return SkillPlan(
            skillName="generic",
            files=[step for step in candidates if step.mode == "create" or (root / step.path).exists()][:MAX_GENERIC_FILES],
        )
    raise RuntimeError("generic plan returned invalid JSON and no deterministic fallback matched")


async def generic_plan(req: ClarifiedRequest, ctx: RepoContext, llm: LLMClient) -> SkillPlan:
    result = await llm.chat(
        [
            {"role": "system", "content": "你是资深代码规划助手。只输出严格 JSON，不要输出 markdown 或解释。"},
            {
                "role": "user",
                "content": f"""分析下面的产品需求，并提出需要修改或新建的文件清单。

需求摘要：{req.summary}
字段名：{req.fieldName}
字段类型：{req.fieldType}
展示位置：{req.displayLocation}
业务规则：{req.businessRule}

仓库概览：
{get_repo_overview(ctx)}

输出 JSON，格式必须是：
{{"files":[{{"path":"相对路径","mode":"modify|create","instruction":"具体实现说明"}}]}}

要求：
- path 必须相对 Conduit 仓库根目录。
- mode="modify" 时，path 必须是真实存在的文件，或能从仓库概览中明确判断为已存在文件。
- mode="create" 时，path 必须放在符合现有约定的位置。
- 不要超过 6 个文件；典型需求控制在 2-4 个文件。
- instruction 要写清楚本文件具体改什么，不能只写“修改这个文件”。
""",
            },
        ],
        {"temperature": 0.1, "maxTokens": 1600},
        {"agent": "plan:generic"},
    )
    try:
        files = parse_plan(result["text"])
    except Exception:
        return _fallback_plan(req, ctx)
    return SkillPlan(skillName="generic", files=files)


class GenericSkill(Skill):
    def __init__(self) -> None:
        super().__init__(
            name="generic",
            description="未命中注册 skill 时使用的通用推理路径",
            match_words=[],
            build_steps=lambda _req, _ctx: [],
        )

    async def plan(self, _req: ClarifiedRequest, _ctx: RepoContext) -> SkillPlan:
        raise RuntimeError("genericSkill.plan 需要 LLM，请直接调用 generic_plan(req, ctx, llm)")


generic_skill = GenericSkill()
generic_skill.locate = default_locate  # type: ignore[method-assign]
generic_skill.generate = default_generate  # type: ignore[method-assign]

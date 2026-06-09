from __future__ import annotations

import json
import re
from pathlib import Path

from orchestrator.skills.base import Skill
from orchestrator.types import FileStep, RepoContext

MAX_GENERIC_FILES = 12


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


def _existing_db_tables(root: Path) -> list[str]:
    """从既有 migration 的 createTable 调用里提取真实表名，供新建/修改 migration 照抄（避免大小写/复数臆造）。"""
    names: set[str] = set()
    mig_dir = root / "backend" / "migrations"
    if not mig_dir.exists():
        return []
    for f in sorted(mig_dir.glob("*.js")):
        try:
            text = f.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        for m in re.finditer(r"""createTable\(\s*['"]([^'"]+)['"]""", text):
            names.add(m.group(1))
    return sorted(names)


def get_repo_overview(ctx: RepoContext) -> str:
    root = Path(ctx.repoPath)
    return "\n".join(
        [
            f"仓库路径：{root}",
            f"当前分支：{ctx.branch}",
            "--- 目录树（最多 2 层）---",
            "\n".join(_list_dir(root, "", 2)[:220]),
            "--- 既有数据库表名（来自 migrations 的 createTable，新建/修改 migration 必须照抄，注意大小写与单复数）---",
            ", ".join(_existing_db_tables(root)) or "(未发现)",
            "--- 后端 migration 文件 ---",
            "\n".join(_list_files(root, "backend/migrations")),
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


def steps_from_file_dicts(files: object) -> list[FileStep]:
    """校验并转换 LLM 返回的 files 数组为 FileStep 列表；超过保险上限时显式报错（不静默截断）。"""
    if not isinstance(files, list):
        raise ValueError("plan 没有返回 files 数组")
    if len(files) > MAX_GENERIC_FILES:
        raise ValueError(
            f"plan 规划了 {len(files)} 个文件，超过上限 {MAX_GENERIC_FILES}；"
            f"需求可能过大，建议拆分后分多次执行，或调高 MAX_GENERIC_FILES。"
        )
    steps: list[FileStep] = []
    for i, f in enumerate(files):
        if not isinstance(f, dict):
            raise ValueError(f"plan.files[{i}] 不是对象")
        path = str(f.get("path", "")).strip()
        mode = f.get("mode")
        instruction = str(f.get("instruction", "")).strip()
        if not path:
            raise ValueError(f"plan.files[{i}] 缺少 path")
        if mode not in {"modify", "create"}:
            raise ValueError(f"plan.files[{i}] mode 必须是 modify 或 create")
        if not instruction:
            raise ValueError(f"plan.files[{i}] 缺少 instruction")
        steps.append(FileStep(path=path, mode=mode, instruction=instruction))
    return steps


# 仅作为 locate/generate 的执行载体；规划与澄清统一走 plan_loop。
generic_skill = Skill(name="generic", description="通用推理执行载体（规划与澄清走 plan_loop）")

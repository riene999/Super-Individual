from __future__ import annotations

import re
from pathlib import Path

LIBRARY_DIR = Path(__file__).resolve().parent / "library"

_CACHE: str | None = None
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


class SkillError(Exception):
    """skill 文件增删改查中的可预期错误（非法名、重名、不存在等），由 API 层转 4xx。"""


def _safe_path(name: str) -> Path:
    """把 skill 名校验成安全 slug 并解析为 library 下的 .md 路径，杜绝路径穿越。"""
    name = (name or "").strip()
    if not _NAME_RE.match(name):
        raise SkillError("skill 名只能用小写字母、数字与连字符，且以字母或数字开头")
    path = (LIBRARY_DIR / f"{name}.md").resolve()
    if path.parent != LIBRARY_DIR.resolve():
        raise SkillError("非法的 skill 名")
    return path


def list_skills() -> list[dict[str, str]]:
    """列出所有 skill 文档（名 + 原始 markdown 全文）。"""
    out: list[dict[str, str]] = []
    if LIBRARY_DIR.exists():
        for md in sorted(LIBRARY_DIR.glob("*.md")):
            try:
                content = md.read_text(encoding="utf-8")
            except Exception:
                continue
            out.append({"name": md.stem, "content": content})
    return out


def read_skill(name: str) -> dict[str, str]:
    path = _safe_path(name)
    if not path.exists():
        raise SkillError(f"skill 不存在：{name}")
    return {"name": path.stem, "content": path.read_text(encoding="utf-8")}


def create_skill(name: str, content: str) -> dict[str, str]:
    path = _safe_path(name)
    if path.exists():
        raise SkillError(f"skill 已存在：{name}")
    path.write_text(content or "", encoding="utf-8")
    reset_skill_docs_cache()
    return {"name": path.stem, "content": content or ""}


def update_skill(name: str, content: str, new_name: str | None = None) -> dict[str, str]:
    path = _safe_path(name)
    if not path.exists():
        raise SkillError(f"skill 不存在：{name}")
    target = path
    if new_name and new_name != name:
        target = _safe_path(new_name)
        if target.exists():
            raise SkillError(f"skill 已存在：{new_name}")
    target.write_text(content or "", encoding="utf-8")
    if target != path:
        path.unlink(missing_ok=True)
    reset_skill_docs_cache()
    return {"name": target.stem, "content": content or ""}


def delete_skill(name: str) -> None:
    path = _safe_path(name)
    if not path.exists():
        raise SkillError(f"skill 不存在：{name}")
    path.unlink()
    reset_skill_docs_cache()


def load_skill_docs(force: bool = False) -> str:
    """读取 skills/library 下所有 .md，拼成一段供 plan agent 全量参考的知识文本。

    每个 md 自带 frontmatter（name/description）+ 正文指引，这里不做解析，直接整段喂给 LLM。
    """
    global _CACHE
    if _CACHE is not None and not force:
        return _CACHE
    parts: list[str] = []
    if LIBRARY_DIR.exists():
        for md in sorted(LIBRARY_DIR.glob("*.md")):
            try:
                text = md.read_text(encoding="utf-8").strip()
            except Exception:
                continue
            if text:
                parts.append(text)
    _CACHE = "\n\n==========\n\n".join(parts) if parts else "（暂无 skill 知识文档）"
    return _CACHE


def reset_skill_docs_cache() -> None:
    global _CACHE
    _CACHE = None

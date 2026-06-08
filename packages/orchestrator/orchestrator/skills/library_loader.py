from __future__ import annotations

from pathlib import Path

LIBRARY_DIR = Path(__file__).resolve().parent / "library"

_CACHE: str | None = None


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

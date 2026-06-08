from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[4]
SPEC_DIR = ROOT / "workspace" / "repo-specs"

SPEC_VERSION = 1
MAX_INDEX_BYTES = 120_000
MAX_INDEX_FILES = 500

SKIP_DIRS = {".git", "node_modules", "dist", "build", "coverage", ".next", ".turbo", "__pycache__"}
SKIP_NAMES = {"package-lock.json", "pnpm-lock.yaml", "yarn.lock"}
SOURCE_SUFFIXES = {
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".py",
    ".css",
    ".scss",
    ".html",
    ".json",
    ".md",
    ".yml",
    ".yaml",
}


def spec_key(repo_nwo: str | None, repo_path: Path) -> str:
    if repo_nwo:
        return repo_nwo.strip("/")
    return f"local/{repo_path.name}"


def spec_root(repo_nwo: str | None, repo_path: Path) -> Path:
    return SPEC_DIR / spec_key(repo_nwo, repo_path)


def spec_paths(repo_nwo: str | None, repo_path: Path) -> dict[str, Path]:
    root = spec_root(repo_nwo, repo_path)
    return {
        "root": root,
        "initial": root / "initial.json",
        "current": root / "current.json",
        "meta": root / "meta.json",
    }


def file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 64), b""):
            h.update(chunk)
    return h.hexdigest()


def should_index(relative_path: str, absolute_path: Path) -> bool:
    parts = set(Path(relative_path).parts)
    if parts & SKIP_DIRS:
        return False
    if absolute_path.name in SKIP_NAMES:
        return False
    if not absolute_path.is_file():
        return False
    if absolute_path.stat().st_size > MAX_INDEX_BYTES:
        return False
    return absolute_path.suffix.lower() in SOURCE_SUFFIXES or absolute_path.name in {"Dockerfile", "Makefile"}


def list_indexable_files(repo_path: Path) -> list[str]:
    files: list[str] = []
    try:
        r = subprocess.run(["git", "ls-files"], cwd=repo_path, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20)
        if r.returncode == 0:
            for line in r.stdout.splitlines():
                rel = line.strip().replace("\\", "/")
                if rel and should_index(rel, repo_path / rel):
                    files.append(rel)
            return sorted(files)[:MAX_INDEX_FILES]
    except Exception:
        pass

    for path in repo_path.rglob("*"):
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        rel = str(path.relative_to(repo_path)).replace("\\", "/")
        if should_index(rel, path):
            files.append(rel)
    return sorted(files)[:MAX_INDEX_FILES]


def read_spec(repo_nwo: str | None, repo_path: Path, kind: str = "current") -> dict[str, Any] | None:
    path = spec_paths(repo_nwo, repo_path).get(kind)
    if not path or not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def write_spec(repo_nwo: str | None, repo_path: Path, kind: str, spec: dict[str, Any]) -> None:
    path = spec_paths(repo_nwo, repo_path)[kind]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(spec, ensure_ascii=False, indent=2), encoding="utf-8")


def empty_spec(repo_nwo: str | None, repo_path: Path, branch: str | None = None) -> dict[str, Any]:
    return {
        "version": SPEC_VERSION,
        "repoNwo": repo_nwo,
        "repoPath": str(repo_path),
        "branch": branch,
        "updatedAt": int(time.time() * 1000),
        "files": {},
    }


def restore_current_from_initial(repo_nwo: str | None, repo_path: Path) -> bool:
    paths = spec_paths(repo_nwo, repo_path)
    if not paths["initial"].exists():
        return False
    paths["current"].parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(paths["initial"], paths["current"])
    return True


def status(repo_nwo: str | None, repo_path: Path) -> dict[str, Any]:
    paths = spec_paths(repo_nwo, repo_path)
    current = read_spec(repo_nwo, repo_path, "current")
    initial = read_spec(repo_nwo, repo_path, "initial")
    return {
        "key": spec_key(repo_nwo, repo_path),
        "initialReady": paths["initial"].exists(),
        "currentReady": paths["current"].exists(),
        "fileCount": len((current or {}).get("files") or {}),
        "initialFileCount": len((initial or {}).get("files") or {}),
    }


def local_file_summary(path: str, content: str) -> dict[str, Any]:
    lines = [line.strip() for line in content.splitlines() if line.strip()]
    imports = [line for line in lines if line.startswith(("import ", "from ")) or "require(" in line][:8]
    symbols: list[str] = []
    for line in lines:
        if line.startswith(("export function ", "function ", "class ", "export default function ")):
            symbols.append(line.split("(")[0].replace("export default ", "").replace("export ", "")[:80])
        if len(symbols) >= 8:
            break
    tags = [part.lower() for part in Path(path).parts if part and part not in {".", ".."}]
    summary = " ".join(lines[:3])[:240] if lines else "Empty file."
    return {"summary": summary, "tags": tags[:12], "symbols": symbols, "imports": imports}

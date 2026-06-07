from __future__ import annotations

import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

from orchestrator.types import FilePatch, RepoContext

ROOT = Path(__file__).resolve().parents[4]
DEFAULT_CONDUIT_PATH = ROOT / "workspace" / "conduit"


@dataclass
class VerifyResult:
    success: bool
    stdout: str
    stderr: str
    exitCode: int


@dataclass
class GrepMatch:
    path: str
    line: int
    content: str


class ConduitRepo:
    def __init__(self) -> None:
        self.repo_path = Path(os.getenv("CONDUIT_REPO_PATH", str(DEFAULT_CONDUIT_PATH)))
        if not self.repo_path.exists():
            raise RuntimeError(f"Conduit repo not found at: {self.repo_path}")

    def read_file(self, relative_path: str) -> str:
        return (self.repo_path / relative_path).read_text(encoding="utf-8")

    def read_file_or_none(self, relative_path: str) -> str | None:
        path = self.repo_path / relative_path
        return path.read_text(encoding="utf-8") if path.exists() else None

    def list_files(self, pattern: str) -> list[str]:
        return sorted(str(p.relative_to(self.repo_path)).replace("\\", "/") for p in self.repo_path.glob(pattern))

    def grep(self, search_pattern: str, glob_pattern: str = "**/*") -> list[GrepMatch]:
        rx = re.compile(search_pattern, re.I)
        results: list[GrepMatch] = []
        for path in self.repo_path.glob(glob_pattern):
            if path.is_dir() or "node_modules" in path.parts:
                continue
            if path.suffix not in {".js", ".jsx", ".ts", ".tsx"}:
                continue
            rel = str(path.relative_to(self.repo_path)).replace("\\", "/")
            for idx, line in enumerate(path.read_text(encoding="utf-8", errors="ignore").splitlines(), start=1):
                if rx.search(line):
                    results.append(GrepMatch(path=rel, line=idx, content=line.strip()))
        return results

    def apply_patches(self, patches: list[FilePatch]) -> None:
        for patch in patches:
            path = self.repo_path / patch.path
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(patch.newContent, encoding="utf-8")

    def run_verify(self, target_files: list[str] | None = None) -> VerifyResult:
        errors: list[str] = []
        for rel in target_files or []:
            path = self.repo_path / rel
            if path.exists() and path.suffix == ".js":
                r = subprocess.run(["node", "--check", str(path)], capture_output=True, text=True, timeout=10)
                if r.returncode != 0:
                    errors.append(f"{rel}: {(r.stderr or '').splitlines()[:3]}")
        if errors:
            return VerifyResult(False, "", "[syntax-guard] " + "\n".join(errors), 1)

        r = subprocess.run(
            ["npm", "test", "--", "--run"],
            cwd=self.repo_path,
            capture_output=True,
            text=True,
            timeout=120,
            shell=True,
        )
        return VerifyResult(r.returncode == 0, r.stdout or "", r.stderr or "", r.returncode)

    def get_context(self) -> RepoContext:
        branch = "main"
        try:
            r = subprocess.run(
                ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                cwd=self.repo_path,
                capture_output=True,
                text=True,
                timeout=10,
            )
            if r.returncode == 0:
                branch = r.stdout.strip()
        except Exception:
            pass
        return RepoContext(repoPath=str(self.repo_path), branch=branch)

    def checkout_branch(self, branch: str) -> None:
        branches = subprocess.run(["git", "branch", "--list", branch], cwd=self.repo_path, capture_output=True, text=True)
        if branches.stdout.strip():
            subprocess.run(["git", "checkout", branch], cwd=self.repo_path, check=True)
        else:
            subprocess.run(["git", "checkout", "-b", branch], cwd=self.repo_path, check=True)

    def stage_and_commit(self, message: str) -> None:
        subprocess.run(["git", "add", "."], cwd=self.repo_path, check=True)
        subprocess.run(["git", "commit", "-m", message], cwd=self.repo_path, check=True)

    def get_diff(self, base: str = "HEAD") -> str:
        r = subprocess.run(["git", "diff", base], cwd=self.repo_path, capture_output=True, text=True)
        if r.returncode == 0:
            return r.stdout
        return subprocess.run(["git", "diff"], cwd=self.repo_path, capture_output=True, text=True).stdout


def create_conduit_repo() -> ConduitRepo:
    return ConduitRepo()


from __future__ import annotations

import os
import re
import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from orchestrator.types import FilePatch, RepoContext

ROOT = Path(__file__).resolve().parents[4]
DEFAULT_CONDUIT_PATH = ROOT / "workspace" / "conduit"
REPOS_DIR = ROOT / "workspace" / "repos"


def _parse_nwo(repo_url: str) -> str:
    m = re.search(r"github\.com[/:]([^/]+/[^/]+?)(?:\.git)?$", repo_url)
    if not m:
        raise ValueError(f"Cannot parse GitHub URL: {repo_url}")
    return m.group(1)


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
    def __init__(self, repo_path: Path | None = None, upstream_nwo: str | None = None) -> None:
        self.repo_path = repo_path or Path(os.getenv("CONDUIT_REPO_PATH", str(DEFAULT_CONDUIT_PATH)))
        self.upstream_nwo = upstream_nwo
        if not self.repo_path.exists():
            raise RuntimeError(f"Repo not found at: {self.repo_path}")

    @classmethod
    def from_url(cls, repo_url: str) -> "ConduitRepo":
        nwo = _parse_nwo(repo_url)
        _, repo_name = nwo.split("/", 1)
        local_path = REPOS_DIR / nwo

        if not local_path.exists():
            local_path.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(["git", "clone", repo_url, str(local_path)], check=True)

            # Fork on GitHub via API
            subprocess.run(["gh", "api", f"repos/{nwo}/forks", "-X", "POST"], capture_output=True)

            # Get authenticated username
            r = subprocess.run(["gh", "api", "user", "-q", ".login"], capture_output=True, text=True, check=True)
            username = r.stdout.strip()

            # Set up remotes: origin → fork, upstream → original
            fork_url = f"https://github.com/{username}/{repo_name}.git"
            subprocess.run(["git", "remote", "rename", "origin", "upstream"], cwd=local_path, check=True)
            subprocess.run(["git", "remote", "add", "origin", fork_url], cwd=local_path, check=True)

        return cls(local_path, upstream_nwo=nwo)

    @classmethod
    def reset_from_url(cls, repo_url: str) -> "ConduitRepo":
        repo = cls.from_url(repo_url)
        repo.reset_to_original()
        return repo

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

        package_json = self.repo_path / "package.json"
        if not package_json.exists():
            return VerifyResult(True, "[verify skipped] package.json not found; syntax guard completed.", "", 0)

        try:
            package = json.loads(package_json.read_text(encoding="utf-8"))
        except Exception as e:
            return VerifyResult(False, "", f"[verify] failed to read package.json: {e}", 1)

        test_script = ((package.get("scripts") or {}).get("test") or "").strip()
        if not test_script:
            return VerifyResult(True, "[verify skipped] npm test script not found; syntax guard completed.", "", 0)

        node_modules = self.repo_path / "node_modules"
        if not node_modules.exists():
            return VerifyResult(
                True,
                "[verify skipped] node_modules not found; run npm install in the target repo to enable npm test. Syntax guard completed.",
                "",
                0,
            )

        if "vitest" in test_script:
            vitest_bins = [
                node_modules / ".bin" / "vitest",
                node_modules / ".bin" / "vitest.cmd",
                node_modules / ".bin" / "vitest.ps1",
            ]
            if not any(p.exists() for p in vitest_bins):
                return VerifyResult(
                    True,
                    "[verify skipped] vitest is not installed in node_modules; run npm install in the target repo to enable npm test. Syntax guard completed.",
                    "",
                    0,
                )

        npm = shutil.which("npm.cmd") or shutil.which("npm")
        if not npm:
            return VerifyResult(True, "[verify skipped] npm not found on PATH; syntax guard completed.", "", 0)

        r = subprocess.run(
            [npm, "test", "--", "--run"],
            cwd=self.repo_path,
            capture_output=True,
            text=True,
            timeout=120,
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

    def _run_git(self, args: list[str]) -> subprocess.CompletedProcess[str]:
        r = subprocess.run(["git", *args], cwd=self.repo_path, capture_output=True, text=True)
        if r.returncode != 0:
            detail = (r.stderr or r.stdout or "").strip()
            raise RuntimeError(f"git {' '.join(args)} failed: {detail}")
        return r

    def _original_remote(self) -> str:
        remotes = set(self._run_git(["remote"]).stdout.split())
        if "upstream" in remotes:
            return "upstream"
        if self.upstream_nwo:
            self._run_git(["remote", "add", "upstream", f"https://github.com/{self.upstream_nwo}.git"])
            return "upstream"
        if "origin" in remotes:
            return "origin"
        raise RuntimeError("No git remote found for repository reset")

    def _remote_default_branch(self, remote: str) -> str:
        r = subprocess.run(
            ["git", "symbolic-ref", "--short", f"refs/remotes/{remote}/HEAD"],
            cwd=self.repo_path,
            capture_output=True,
            text=True,
        )
        if r.returncode == 0 and "/" in r.stdout.strip():
            return r.stdout.strip().split("/", 1)[1]

        for branch in ("main", "master"):
            r = subprocess.run(["git", "rev-parse", "--verify", f"{remote}/{branch}"], cwd=self.repo_path, capture_output=True, text=True)
            if r.returncode == 0:
                return branch
        raise RuntimeError(f"Cannot determine default branch for remote {remote}")

    def reset_to_original(self) -> None:
        index_lock = self.repo_path / ".git" / "index.lock"
        if index_lock.exists():
            raise RuntimeError(f"Git index lock exists at {index_lock}; remove it after confirming no git process is running.")

        remote = self._original_remote()
        self._run_git(["fetch", remote, "--prune"])
        subprocess.run(["git", "remote", "set-head", remote, "-a"], cwd=self.repo_path, capture_output=True, text=True)
        branch = self._remote_default_branch(remote)
        self._run_git(["checkout", "-B", branch, f"{remote}/{branch}"])
        self._run_git(["reset", "--hard", f"{remote}/{branch}"])
        self._run_git(["clean", "-fd", "-e", "node_modules/", "-e", "frontend/node_modules/", "-e", "backend/node_modules/"])

    def stage_and_commit(self, message: str, paths: list[str] | None = None) -> None:
        index_lock = self.repo_path / ".git" / "index.lock"
        if index_lock.exists():
            raise RuntimeError(f"Git index lock exists at {index_lock}; remove it after confirming no git process is running.")

        pathspec = paths or ["."]
        self._run_git(["add", "--", *pathspec])
        self._run_git(["commit", "-m", message])

    def push_branch(self, branch: str) -> None:
        subprocess.run(["git", "push", "-u", "origin", branch], cwd=self.repo_path, check=True)

    def create_pr(self, branch: str, title: str, body: str) -> str:
        cmd = ["gh", "pr", "create", "--title", title, "--body", body, "--base", "main", "--head", branch]
        if self.upstream_nwo:
            cmd += ["--repo", self.upstream_nwo]
        r = subprocess.run(cmd, cwd=self.repo_path, capture_output=True, text=True, check=True)
        return r.stdout.strip()

    def get_diff(self, base: str = "HEAD") -> str:
        r = subprocess.run(["git", "diff", base], cwd=self.repo_path, capture_output=True, text=True)
        if r.returncode == 0:
            return r.stdout
        return subprocess.run(["git", "diff"], cwd=self.repo_path, capture_output=True, text=True).stdout


def create_conduit_repo() -> ConduitRepo:
    return ConduitRepo()

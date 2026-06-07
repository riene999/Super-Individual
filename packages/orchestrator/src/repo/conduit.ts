import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync, spawnSync } from "child_process";
import { glob } from "glob";
import simpleGit from "simple-git";
import type { FilePatch, RepoContext } from "../types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// packages/orchestrator/src/repo → ../../../../workspace/conduit
const DEFAULT_CONDUIT_PATH = join(__dirname, "../../../../workspace/conduit");

function getRepoPath(): string {
  return process.env.CONDUIT_REPO_PATH || DEFAULT_CONDUIT_PATH;
}

export interface VerifyResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GrepMatch {
  path: string;   // relative to conduit root
  line: number;
  content: string;
}

export interface ConduitRepo {
  repoPath: string;
  readFile(relativePath: string): string;
  readFileOrNull(relativePath: string): string | null;
  listFiles(pattern: string): Promise<string[]>;
  grep(searchPattern: string, globPattern?: string): Promise<GrepMatch[]>;
  applyPatches(patches: FilePatch[]): void;
  /** targetFiles 用于做语法守门；不传则跳过语法检查直接跑测试 */
  runVerify(targetFiles?: string[]): Promise<VerifyResult>;
  getContext(): RepoContext;
  getCurrentBranch(): Promise<string>;
  checkoutBranch(branch: string): Promise<void>;
  stageAndCommit(message: string): Promise<void>;
  getDiff(base?: string): Promise<string>;
}

// ────────────────────────────────────────────────────────────
// 语法守门：JS 用 node --check，JSX 用 esbuild transform
// ────────────────────────────────────────────────────────────

async function checkSyntax(
  repoPath: string,
  files: string[],
): Promise<{ success: boolean; errors: string[] }> {
  const errors: string[] = [];
  // esbuild 是 vite 间接依赖，无新增
  const esbuild = await import("esbuild").catch(() => null);

  for (const f of files) {
    const full = join(repoPath, f);
    if (!existsSync(full)) continue;
    const ext = f.split(".").pop()?.toLowerCase();

    if (ext === "js") {
      // node --check 验 CommonJS / ES 语法
      const r = spawnSync("node", ["--check", full], { encoding: "utf8", timeout: 10_000 });
      if (r.status !== 0) errors.push(`${f}: ${(r.stderr || "").split("\n").slice(0, 3).join(" | ")}`);
    } else if (ext === "jsx" || ext === "tsx" || ext === "ts") {
      if (!esbuild) continue;
      try {
        await esbuild.transform(readFileSync(full, "utf8"), {
          loader: ext === "jsx" ? "jsx" : ext as "ts" | "tsx",
          sourcefile: f,
        });
      } catch (e) {
        const msg = (e as Error).message.split("\n").slice(0, 3).join(" | ");
        errors.push(`${f}: ${msg}`);
      }
    }
  }
  return { success: errors.length === 0, errors };
}

export function createConduitRepo(): ConduitRepo {
  const repoPath = getRepoPath();
  const git = simpleGit(repoPath);

  if (!existsSync(repoPath)) {
    throw new Error(`Conduit repo not found at: ${repoPath}`);
  }

  return {
    repoPath,

    readFile(relativePath) {
      return readFileSync(join(repoPath, relativePath), "utf8");
    },

    readFileOrNull(relativePath) {
      const full = join(repoPath, relativePath);
      return existsSync(full) ? readFileSync(full, "utf8") : null;
    },

    async listFiles(pattern) {
      const matches = await glob(pattern, { cwd: repoPath, ignore: ["**/node_modules/**"] });
      return matches.sort();
    },

    async grep(searchPattern, globPattern = "**/*.{js,jsx,ts,tsx}") {
      const files = await glob(globPattern, { cwd: repoPath, ignore: ["**/node_modules/**"] });
      const results: GrepMatch[] = [];
      const re = new RegExp(searchPattern, "i");

      for (const f of files) {
        const content = readFileSync(join(repoPath, f), "utf8");
        content.split("\n").forEach((line, idx) => {
          if (re.test(line)) {
            results.push({ path: f, line: idx + 1, content: line.trim() });
          }
        });
      }
      return results;
    },

    applyPatches(patches) {
      for (const patch of patches) {
        const full = join(repoPath, patch.path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, patch.newContent, "utf8");
      }
    },

    async runVerify(targetFiles?: string[]) {
      // 守门 1：对目标文件做语法检查（Conduit 无 ESLint，自建最小守门）
      if (targetFiles?.length) {
        const syntaxCheck = await checkSyntax(repoPath, targetFiles);
        if (!syntaxCheck.success) {
          return {
            success: false,
            stdout: "",
            stderr: `[syntax-guard] ${syntaxCheck.errors.join("\n")}`,
            exitCode: 1,
          };
        }
      }
      // 守门 2：跑测试
      const result = spawnSync("npm", ["test", "--", "--run"], {
        cwd: repoPath,
        encoding: "utf8",
        timeout: 120_000,
        shell: true,
      });
      return {
        success: result.status === 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.status ?? 1,
      };
    },

    getContext(): RepoContext {
      let branch = "main";
      try {
        branch = execSync("git rev-parse --abbrev-ref HEAD", {
          cwd: repoPath,
          encoding: "utf8",
        }).trim();
      } catch { /* ignore */ }
      return { repoPath, branch };
    },

    async getCurrentBranch() {
      const result = await git.revparse(["--abbrev-ref", "HEAD"]);
      return result.trim();
    },

    async checkoutBranch(branch) {
      const branches = await git.branchLocal();
      if (branches.all.includes(branch)) {
        await git.checkout(branch);
      } else {
        await git.checkoutLocalBranch(branch);
      }
    },

    async stageAndCommit(message) {
      await git.add(".");
      await git.commit(message);
    },

    async getDiff(base = "HEAD") {
      try {
        return await git.diff([base]);
      } catch {
        return await git.diff();
      }
    },
  };
}

import type { ConduitRepo } from "../repo/conduit.js";

/** 检测召回的历史路径在当前 repo 是否仍存在。 */
export function validateRecalledFiles(
  repo: ConduitRepo,
  files: string[],
): { valid: string[]; stale: string[] } {
  const valid: string[] = [];
  const stale: string[] = [];
  for (const f of files) {
    if (repo.readFileOrNull(f) !== null) valid.push(f);
    else stale.push(f);
  }
  return { valid, stale };
}

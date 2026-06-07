import type { ConduitRepo, VerifyResult } from "../repo/conduit.js";

export const verifyAgent = {
  async run(repo: ConduitRepo, targetFiles?: string[]): Promise<VerifyResult> {
    console.log("[verify] 语法守门 + npm test ...");
    const result = await repo.runVerify(targetFiles);
    console.log(`[verify] exit=${result.exitCode} success=${result.success}`);
    if (!result.success) {
      console.log("[verify] stderr:", result.stderr.slice(0, 300));
    }
    return result;
  },
};

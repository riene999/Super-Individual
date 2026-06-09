from orchestrator.repo.conduit import ConduitRepo, VerifyResult


async def run(repo: ConduitRepo, target_files: list[str] | None = None) -> VerifyResult:
    return repo.run_verify(target_files)


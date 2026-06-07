from orchestrator.types import Layer


def infer_layers(changed_files: list[str]) -> list[Layer]:
    found: set[Layer] = set()
    for f in changed_files:
        norm = f.replace("\\", "/").lower()
        if "models/" in norm or "migrations" in norm:
            found.add("db")
        if norm.startswith("backend/") or "/backend/" in norm:
            found.add("backend")
        if norm.startswith("frontend/") or "/frontend/" in norm:
            found.add("frontend")
    return [x for x in ["db", "backend", "frontend"] if x in found]


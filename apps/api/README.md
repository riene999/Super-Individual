# Python API

这是后端 API 的 FastAPI 版本，用来和现有 TypeScript API 并行验证。

使用 uv 启动：

```bash
cd apps/api_py
uv run uvicorn app.main:app --host 0.0.0.0 --port 3001 --reload
```

只要 Vite 继续把 `/api` 代理到 `3001` 端口，React 前端不需要改语言，也不需要改调用路径。

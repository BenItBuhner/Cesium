## Cursor Cloud specific instructions

### Architecture

OpenCursor is a two-package TypeScript project (not a monorepo tool like Turborepo):

| Package | Path | Role | Port |
|---------|------|------|------|
| `opencursor` | `/workspace` | Next.js 16 frontend (App Router, React 19) | 3000 |
| `opencursor-server` | `/workspace/server` | Hono backend (filesystem, terminals, agent orchestration) | 9100 |

No database -- all persistence is file-based JSON under `~/.local/state/opencursor/`.

### Running services

```bash
# Backend (must start first -- frontend expects it on :9100)
npm run dev:server          # from repo root, or `npm run dev` from server/

# Frontend
npm run dev                 # from repo root
```

The frontend redirects `/` to `/editor`. Confirm backend health with `curl http://localhost:9100/health`.

### Environment files

- Root `.env.local`: set `NEXT_PUBLIC_SERVER_URL=http://localhost:9100`
- `server/.env`: set `WORKSPACE_ROOT=/workspace`, `PORT=9100`, and optionally `OPENCURSOR_ALLOW_ANY_WORKSPACE_ROOT=1`

### Lint / Test / Build

- **Lint**: `npx eslint .` (from root). Pre-existing warnings/errors exist in the codebase.
- **Test**: `npm test` (from `server/`). Uses Node.js built-in test runner. Test 5 ("persisted provider sessions rehydration") is flaky and may time out -- this is pre-existing.
- **Build frontend**: `npm run build` (from root).
- **Build server**: `npm run build` (from `server/`).

### Gotchas

- `node-pty` is a native module. Build tools (Python 3, gcc, g++, make) must be available for `npm install` in `server/`.
- AI agent features (chat panel) require external CLI binaries on `$PATH` (e.g. `claude`, `codex`, `gemini`). The IDE works fine without them for file editing and terminal usage.
- The server uses `tsx watch` for hot reload in dev mode. If you change dependencies, restart the server process.

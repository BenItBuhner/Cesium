# AGENTS.md

## Cursor Cloud specific instructions

### Product (default dev scope)

Cesium is a local-first AI workbench monorepo. For web end-to-end work you need:

| Service | Port | Start |
| --- | --- | --- |
| Bun API (`server/`) | 9100 | `npm run dev:server` (from repo root) |
| Next.js UI (repo root app) | 3000 | See **Frontend** below |

Copy `.env.example` → `.env.local` if missing. Set `NEXT_PUBLIC_SERVER_URL=http://localhost:9100` and `WORKSPACE_ROOT` to a folder under an allowed root (e.g. `/workspace`).

### Prerequisites

- **Node.js** 22+ (LTS) and **npm** (workspaces at repo root).
- **Bun** for the backend (`server` scripts use `bun`). If `bun` is not on `PATH`, install once: `curl -fsSL https://bun.sh/install | bash` and ensure `~/.bun/bin` is on `PATH`.
- **Docker** is optional (Postgres on 5433, Redis on 6380 via `docker compose up -d`). Default dev uses legacy JSON storage with no Docker.

### Frontend (Cloud VM note)

`npm run dev` (Turbopack) has been observed to panic or throw `RangeError: Invalid array length` in some cloud VMs. Prefer:

```bash
npm run build && npm run start
```

for a stable UI on port 3000. Backend can stay on `npm run dev:server`.

### Commands (see `package.json` / `README.md`)

| Task | Command |
| --- | --- |
| Install deps | `npm install` and `npm install --prefix server` |
| Lint (root) | `npm run lint` |
| Unit tests (root) | `npm test` |
| Server tests | `npm test --prefix server` |
| Backend dev | `npm run dev:server` |
| Frontend (stable) | `npm run build && npm run start` |

Desktop (`npm run dev:desktop`) and mobile (`npm run dev:mobile` / Detox) need extra tooling (Electron, Android emulator) and are out of scope unless explicitly requested.

### Health checks

- Backend: `curl http://localhost:9100/health` → `{"ok":true,...}`
- Frontend: `curl -o /dev/null -w '%{http_code}' http://localhost:3000/` → `200` when `next start` is running

### API smoke test

With backend up and workspace id from `GET /api/workspaces`:

```bash
curl -H "x-opencursor-workspace-id: <id>" "http://localhost:9100/api/fs/tree?path=.&depth=1"
```

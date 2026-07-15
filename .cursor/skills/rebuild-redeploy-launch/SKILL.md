---
name: rebuild-redeploy-launch
description: Rebuilds the Cesium/opencursor Next frontend and/or Electron desktop app, redeploys the Bun API and Next production servers, reinstalls the Windows unpacked Electron build, and opens the site or app. Use when the user asks to rebuild, redeploy, restart servers, reinstall or relaunch Cesium/Electron, refresh production locally, or verify changes in the running app.
disable-model-invocation: true
---

# Rebuild, redeploy, and launch (opencursor)

End-to-end workflow for this monorepo. Run from the **repository root** unless noted.

## 0. Decide scope (AskQuestion if unclear)

Use **AskQuestion** when the user did not say which surfaces to touch. Typical question:

- **Prompt:** Which targets should be rebuilt/redeployed?
- **Options (multi-select allowed):**
  - **Next + API (default production stack)** — root Next on `:3000` and `cesium-server` on `:9100` (what README calls the two long-running processes)
  - **Second Next (`@cesium/web`)** — workspace app on `:4000` (only when the user or prior session explicitly used both Next apps)
  - **Electron desktop** — `@cesium/desktop` packaged install

**Infer without asking when:**

| User says | Do |
| --- | --- |
| "redeploy servers", "restart API", "server on 9100", backend-only fix | API `:9100` (+ rebuild `server/`); restart Next only if frontend also changed |
| "rebuild Next", "refresh website", "localhost:3000" | Root Next build + `:3000` redeploy |
| "both Next", "two Next servers", prior work used `:4000` | Root Next **and** `@cesium/web` |
| "Electron", "desktop", "Cesium.exe", "reinstall app" | Electron pipeline (Windows) |
| "everything", "all", "parallel" | Next+API **and** Electron; see §5 for parallel subagents |

**Primary UI** is the **root** Next app (`npm run build` / `npm run start`, port **3000**). `@cesium/web` is a separate workspace copy—do not start it unless requested.

## 1. Rebuild

Always `cd` to repo root first. Check `git diff` / the user message for whether shared packages changed.

### Shared packages (when `packages/*` or protocol types changed)

```bash
npm run build:packages
```

Or at minimum:

```bash
npm run build --workspace @cesium/core
```

### API server (`cesium-server`)

```bash
npm --prefix server run build
```

### Root Next (main workbench)

```bash
npm run build
```

Uses `.env.local` for `NEXT_PUBLIC_*` at build time.

### `@cesium/web` (optional second Next)

```bash
npm run build --workspace @cesium/web
```

### Electron (`@cesium/desktop`)

Build is included in install. Desktop `build` compiles core, desktop-renderer, server, and runs shell check:

```bash
npm run build --workspace @cesium/desktop
```

**Windows reinstall (preferred — bundles package + copy to `%LOCALAPPDATA%`):**

```powershell
Get-Process -Name Cesium -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
npm run install:unpacked --workspace @cesium/desktop
```

`install:unpacked` runs `package` then `scripts/install-desktop-unpacked.cjs`. Install path: `%LOCALAPPDATA%\Programs\Cesium\Cesium.exe`.

On non-Windows, `install:unpacked` fails by design—use `npm run package --workspace @cesium/desktop` only.

## 2. Redeploy servers (Next + API)

### Stop listeners

**Windows (PowerShell):**

```powershell
foreach ($port in 3000,3001,4000,9100) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}
Start-Sleep -Seconds 2
```

Only include `4000` if redeploying `@cesium/web`.

**Linux (homelab / `scripts/remote-deploy-opencursor.sh` pattern):**

```bash
fuser -k 9100/tcp 2>/dev/null || true
fuser -k 3000/tcp 2>/dev/null || true
sleep 2
```

For a full remote host refresh after `git pull`, run `scripts/remote-deploy-opencursor.sh` on the machine (builds core + server + root Next, restarts both, smoke-checks health).

### Start API (background)

```bash
npm run start --prefix server
```

Default: **http://localhost:9100** (`PORT` / `HOST` from `server/.env`).

**Linux detached:**

```bash
setsid npm run start --prefix server >> logs/server.log 2>&1 < /dev/null &
```

### Start root Next (background)

```powershell
$env:PORT = '3000'
npm run start
```

**Linux detached:**

```bash
setsid env PORT=3000 npm run start >> logs/next.log 2>&1 < /dev/null &
```

### Start `@cesium/web` (only if in scope)

From `apps/web`:

```powershell
$env:PORT = '4000'
npm run start
```

### Verify redeploy

**Windows:**

```powershell
Get-NetTCPConnection -LocalPort 3000,9100 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalPort, OwningProcess
Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:9100/health' -TimeoutSec 15
Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/workspace' -TimeoutSec 30
```

For Electron packaged backend, confirm a listener owned by a `Cesium` process after launch.

## 3. Reinstall and launch Electron

After §1 Electron build on **Windows**:

1. Stop `Cesium` processes (avoids EPERM during copy).
2. `npm run install:unpacked --workspace @cesium/desktop`
3. Launch:

```powershell
Start-Process "$env:LOCALAPPDATA\Programs\Cesium\Cesium.exe"
Start-Sleep -Seconds 5
Get-Process -Name Cesium -ErrorAction SilentlyContinue | Select-Object Id, Path
```

**Smoke test** if the UI fails silently:

```powershell
& "$env:LOCALAPPDATA\Programs\Cesium\Cesium.exe" --smoke
```

## 4. Open the site or app

| Target | Open |
| --- | --- |
| Root Next | http://localhost:3000 (workspace: `/workspace`) |
| `@cesium/web` | http://localhost:4000 |
| Electron | `%LOCALAPPDATA%\Programs\Cesium\Cesium.exe` or Desktop/Start Menu **Cesium** shortcut |

Prefer **cursor-app-control** `open_resource` with the URL when available; otherwise `Start-Process` (Windows) or `xdg-open` (Linux).

If the user uses a **LAN or custom origin**, open the URL they use (e.g. from `NEXT_PUBLIC_SERVER_URL` / homelab host), not only localhost.

## 5. Parallel work (optional)

When the user wants **Next+API** and **Electron** at once:

- Subagent A (`shell`): §1–§2 for server/Next redeploy
- Subagent B (`shell`): §1 §3 Electron on Windows

Merge results: commands, exit codes, PIDs/ports, URLs opened, blockers.

## 6. Reporting

Summarize:

1. **Scope** chosen (and whether AskQuestion was used)
2. **Commands** run and exit status
3. **Listeners** — ports 3000 / 4000 / 9100 / Electron child port
4. **Opened** — exact URL or exe path
5. **Blockers** — EPERM (quit Cesium), build errors, missing Bun, port still in use

Do **not** commit unless the user asks. Do **not** run destructive git commands.

## Quick reference

| Component | Build | Run / redeploy |
| --- | --- | --- |
| API | `npm --prefix server run build` | `npm run start --prefix server` → `:9100` |
| Root Next | `npm run build` | `PORT=3000` + `npm run start` → `:3000` |
| `@cesium/web` | `npm run build --workspace @cesium/web` | `cd apps/web`, `PORT=4000`, `npm run start` |
| Electron (Win) | `npm run install:unpacked --workspace @cesium/desktop` | `Cesium.exe` under `%LOCALAPPDATA%\Programs\Cesium` |

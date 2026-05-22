#!/usr/bin/env bash
# Run ON the Linux host: fixes .env.local, pulls, rebuilds, restarts Next + API.
set -euo pipefail
ROOT="${1:-$HOME/projects/Cesium}"
cd "$ROOT"
ROOT="$(pwd)"
export ROOT
NEXT_PUBLIC_SERVER_URL="${NEXT_PUBLIC_SERVER_URL:-http://192.168.4.172:9100}"

echo "==> Repo: $ROOT"
git fetch origin main
git pull --ff-only origin main

ENV_LOCAL="$ROOT/.env.local"
python3 << PY
from pathlib import Path
p = Path(r"$ENV_LOCAL")
key = "NEXT_PUBLIC_SERVER_URL"
val = r"$NEXT_PUBLIC_SERVER_URL"
lines = p.read_text(encoding="utf-8").splitlines() if p.exists() else []
out, found = [], False
for line in lines:
    if line.startswith(key + "="):
        out.append(f"{key}={val}")
        found = True
    else:
        out.append(line)
if not found:
    out.insert(0, f"{key}={val}")
p.write_text("\n".join(out) + "\n", encoding="utf-8")
print(f"Updated {key} in .env.local")
PY

echo "==> Build packages"
npm run build --workspace @cesium/core

echo "==> Build server"
npm run build --prefix server

echo "==> Build Next (NEXT_PUBLIC_* from .env.local)"
npm run build

mkdir -p "$ROOT/logs"

echo "==> Stop listeners on 3000 and 9100"
if command -v fuser >/dev/null 2>&1; then
  fuser -k 9100/tcp 2>/dev/null || true
  fuser -k 3000/tcp 2>/dev/null || true
fi
sleep 2

echo "==> Start API"
setsid npm run start --prefix server >> "$ROOT/logs/server.log" 2>&1 < /dev/null &
echo "API npm pid $!"

echo "==> Start Next (port 3000)"
setsid env PORT=3000 npm run start >> "$ROOT/logs/next.log" 2>&1 < /dev/null &
echo "Next npm pid $!"

sleep 5
echo "==> Listen check"
ss -tlnp | grep -E ':3000|:9100' || true

echo "==> Smoke: health + auth bootstrap"
python3 << 'SMOKE'
import json, os, urllib.request, http.cookiejar
from pathlib import Path

root = Path(os.environ["ROOT"])
env_path = root / "server" / ".env"
pw = None
for line in env_path.read_text(encoding="utf-8").splitlines():
    if line.startswith("OPENCURSOR_AUTH_PASSWORD="):
        pw = line.split("=", 1)[1].strip()
        break
if not pw:
    raise SystemExit("missing OPENCURSOR_AUTH_PASSWORD in server/.env")

with urllib.request.urlopen(
    urllib.request.Request(
        "http://127.0.0.1:9100/health",
        method="GET",
    ),
    timeout=10,
) as r:
    print("health:", r.read()[:120])

cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
login = urllib.request.Request(
    "http://127.0.0.1:9100/api/auth/login",
    data=json.dumps({"username": "admin", "password": pw}).encode(),
    headers={"Content-Type": "application/json"},
    method="POST",
)
with opener.open(login, timeout=25) as r:
    body = json.loads(r.read().decode())
print("login ok:", body.get("ok"), "authenticated:", body.get("authenticated"))

with opener.open(
    urllib.request.Request("http://127.0.0.1:9100/api/workspaces/bootstrap", method="GET"),
    timeout=45,
) as r:
    data = json.loads(r.read().decode())
ws = data.get("workspaces") or []
print("bootstrap workspaces:", len(ws), "startup:", data.get("startupWorkspaceId"))
SMOKE

echo "==> Done. Logs: $ROOT/logs/server.log $ROOT/logs/next.log"

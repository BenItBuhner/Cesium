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
export ENV_LOCAL NEXT_PUBLIC_SERVER_URL
node <<'NODE'
const fs = require("node:fs");
const path = process.env.ENV_LOCAL;
const key = "NEXT_PUBLIC_SERVER_URL";
const value = process.env.NEXT_PUBLIC_SERVER_URL ?? "";
const lines = fs.existsSync(path)
  ? fs.readFileSync(path, "utf8").split(/\r?\n/).filter((line, index, all) => index < all.length - 1 || line)
  : [];
let found = false;
const out = lines.map((line) => {
  if (line.startsWith(`${key}=`)) {
    found = true;
    return `${key}=${value}`;
  }
  return line;
});
if (!found) {
  out.unshift(`${key}=${value}`);
}
fs.writeFileSync(path, `${out.join("\n")}\n`, "utf8");
console.log(`Updated ${key} in .env.local`);
NODE

echo "==> Build packages"
npm run build --workspace @cesium/core

# The runtime below starts bun from source (npm run start -> bun-server.ts);
# this tsc build is a typecheck/compile gate, dist/ is NOT what gets served.
echo "==> Typecheck server (compile gate; runtime is bun-from-source)"
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
node <<'NODE'
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = process.env.ROOT;
const envPath = path.join(root, "server", ".env");
const envLines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
const passwordLine = envLines.find((line) => line.startsWith("OPENCURSOR_AUTH_PASSWORD="));
const password = passwordLine?.split("=", 2)[1]?.trim();
if (!password) {
  throw new Error("missing OPENCURSOR_AUTH_PASSWORD in server/.env");
}

let cookie = "";

function requestJson(pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ? Buffer.from(JSON.stringify(options.body)) : null;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: 9100,
        path: pathname,
        method: options.method ?? "GET",
        timeout: options.timeout ?? 25_000,
        headers: {
          ...(body
            ? {
                "Content-Type": "application/json",
                "Content-Length": body.length,
              }
            : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (res) => {
        const chunks = [];
        const setCookie = res.headers["set-cookie"];
        if (setCookie?.length) {
          cookie = setCookie.map((value) => value.split(";", 1)[0]).join("; ");
        }
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`${pathname} failed with ${res.statusCode}: ${text}`));
            return;
          }
          resolve(options.raw ? text : JSON.parse(text));
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`${pathname} timed out`)));
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

(async () => {
  const health = await requestJson("/health", { raw: true, timeout: 10_000 });
  console.log("health:", health.slice(0, 120));

  const login = await requestJson("/api/auth/login", {
    method: "POST",
    body: { username: "admin", password },
  });
  console.log("login ok:", login.ok, "authenticated:", login.authenticated);

  const bootstrap = await requestJson("/api/workspaces/bootstrap", {
    timeout: 45_000,
  });
  const workspaces = bootstrap.workspaces ?? [];
  console.log("bootstrap workspaces:", workspaces.length, "startup:", bootstrap.startupWorkspaceId);
})().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
NODE

echo "==> Done. Logs: $ROOT/logs/server.log $ROOT/logs/next.log"

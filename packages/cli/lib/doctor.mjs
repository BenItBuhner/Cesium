import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import process from "node:process";
import { parseEnvFile, hasSecret } from "./env-file.mjs";
import { bundledInstallerPath, cesiumHome, envFilePath, managerPath } from "./paths.mjs";

const LOG_TAIL_LINES = 20;

/**
 * @typedef {{
 *   id: string,
 *   status: "ok" | "warn" | "fail" | "skip",
 *   title: string,
 *   detail: string,
 *   hint?: string,
 * }} DoctorCheck
 */

function ok(id, title, detail, hint) {
  return { id, status: "ok", title, detail, hint };
}
function warn(id, title, detail, hint) {
  return { id, status: "warn", title, detail, hint };
}
function fail(id, title, detail, hint) {
  return { id, status: "fail", title, detail, hint };
}
function skip(id, title, detail, hint) {
  return { id, status: "skip", title, detail, hint };
}

function fileExists(filePath) {
  try {
    statSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function isExecutable(filePath) {
  try {
    statSync(filePath);
    // eslint-disable-next-line no-bitwise
    return (statSync(filePath).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function readPid(filePath) {
  if (!fileExists(filePath)) {
    return null;
  }
  const raw = readFileSync(filePath, "utf8").trim();
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  return Number(raw);
}

function processCommand(pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tailLines(filePath, count) {
  if (!fileExists(filePath)) {
    return "";
  }
  const text = readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - count)).join("\n").trimEnd();
}

function probePort(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function fetchWithCurl(url, timeoutSec = 3) {
  try {
    const output = execFileSync(
      "curl",
      [
        "-sS",
        "--max-time",
        String(timeoutSec),
        "-H",
        "Accept: application/json",
        "-w",
        "\n%{http_code}",
        url,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    const newline = output.lastIndexOf("\n");
    const body = newline === -1 ? output : output.slice(0, newline);
    const status = Number((newline === -1 ? "" : output.slice(newline + 1)).trim());
    if (!Number.isInteger(status) || status <= 0) {
      return { ok: false, status: 0, body, error: "curl returned no HTTP status" };
    }
    return { ok: status >= 200 && status < 300, status, body };
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
    return {
      ok: false,
      status: 0,
      body: "",
      error: (stderr || (error instanceof Error ? error.message : String(error))).trim() || "curl failed",
    };
  }
}

function fetchText(url, timeoutMs = 2500) {
  if (hasCurl()) {
    return Promise.resolve(fetchWithCurl(url, Math.max(1, Math.ceil(timeoutMs / 1000))));
  }
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      resolve({
        ok: false,
        status: 0,
        body: "",
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (parsed.protocol === "https:") {
      resolve({
        ok: false,
        status: 0,
        body: "",
        error: "use raw HTTP for local engine checks; https endpoints are probed separately",
      });
      return;
    }

    const port = Number(parsed.port || 80);
    const host = parsed.hostname;
    const requestPath = `${parsed.pathname}${parsed.search}` || "/";
    const socket = createConnection({ host, port });
    let settled = false;
    const chunks = [];
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, status: 0, body: "", error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    socket.once("connect", () => {
      socket.write(
        `GET ${requestPath} HTTP/1.1\r\nHost: ${host}${parsed.port ? `:${parsed.port}` : ""}\r\nConnection: close\r\n\r\n`
      );
    });
    socket.on("data", (chunk) => {
      chunks.push(chunk);
    });
    socket.once("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const separator = raw.indexOf("\r\n\r\n");
      const headerBlock = separator === -1 ? raw : raw.slice(0, separator);
      const body = separator === -1 ? "" : raw.slice(separator + 4);
      const statusMatch = headerBlock.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/);
      const status = statusMatch ? Number(statusMatch[1]) : 0;
      finish({ ok: status >= 200 && status < 300, status, body });
    });
    socket.once("error", (error) => {
      finish({ ok: false, status: 0, body: "", error: error.message });
    });
  });
}

let curlAvailable = null;
function hasCurl() {
  if (curlAvailable != null) {
    return curlAvailable;
  }
  try {
    execFileSync("bash", ["-lc", "command -v curl"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    curlAvailable = true;
  } catch {
    curlAvailable = false;
  }
  return curlAvailable;
}

function fetchHttpsHead(url, timeoutMs = 4000) {
  if (hasCurl()) {
    return Promise.resolve(fetchWithCurl(url, Math.max(1, Math.ceil(timeoutMs / 1000))));
  }
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      resolve({
        ok: false,
        status: 0,
        body: "",
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (parsed.protocol !== "https:") {
      fetchText(url, timeoutMs).then(resolve);
      return;
    }
    import("node:https")
      .then(({ default: https }) => {
        const request = https.request(
          {
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: `${parsed.pathname}${parsed.search}` || "/",
            method: "GET",
            timeout: timeoutMs,
            rejectUnauthorized: true,
          },
          (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => {
              const status = response.statusCode ?? 0;
              resolve({
                ok: status >= 200 && status < 300,
                status,
                body: Buffer.concat(chunks).toString("utf8"),
              });
            });
          }
        );
        request.on("timeout", () => {
          request.destroy();
          resolve({ ok: false, status: 0, body: "", error: `timeout after ${timeoutMs}ms` });
        });
        request.on("error", (error) => {
          resolve({ ok: false, status: 0, body: "", error: error.message });
        });
        request.end();
      })
      .catch((error) => {
        resolve({
          ok: false,
          status: 0,
          body: "",
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });
}

function parseCloudDefaults(sourceDir) {
  const file = path.join(sourceDir, "src/lib/cloud/cloud-defaults.ts");
  if (!fileExists(file)) {
    return null;
  }
  const text = readFileSync(file, "utf8");
  const convex = text.match(/convexUrl:\s*"([^"]*)"/);
  const clerk = text.match(/clerkPublishableKey:\s*"([^"]*)"/);
  return {
    convexUrl: convex?.[1] ?? "",
    clerkPublishableKey: clerk?.[1] ?? "",
  };
}

function parseDotEnv(filePath) {
  if (!fileExists(filePath)) {
    return {};
  }
  return parseEnvFile(readFileSync(filePath, "utf8"));
}

function lookLikeCesiumHealth(body) {
  return body.includes('"ok":true') || body.includes('"ok": true');
}

/**
 * @param {{ applyFixes: boolean }} options
 */
export async function runDoctor(options) {
  const applyFixes = options.applyFixes !== false;
  /** @type {DoctorCheck[]} */
  const checks = [];
  /** @type {string[]} */
  const repairs = [];
  /** @type {string[]} */
  const next = [];

  const home = cesiumHome();
  const manager = managerPath(home);
  const envPath = envFilePath(home);
  const logsDir = path.join(home, "logs");
  const runDir = path.join(home, "run");

  if (process.platform === "win32") {
    checks.push(
      fail(
        "platform",
        "platform",
        "This CLI talks to a Bun/POSIX engine.",
        "Run `cesium` inside WSL, or use the desktop app."
      )
    );
    return { home, checks, repairs, next, exitCode: 1 };
  }
  checks.push(ok("platform", "platform", `${process.platform} ${process.arch}`));

  const installed = fileExists(manager) && fileExists(envPath);
  if (!installed) {
    checks.push(
      fail(
        "install",
        "install",
        `No managed engine at ${home} (missing ${fileExists(manager) ? "server.env" : "bin/cesium-server"}).`,
        "CLI-only path: `cesium install --no-start` then `cesium start`. Pair with a web deploy via `--web-url`."
      )
    );
    const bundled = bundledInstallerPath();
    if (bundled) {
      next.push(`This checkout can install from source: cesium install --from-source ${path.resolve(bundled, "../..")} --no-start --skip-tunnel`);
    } else {
      next.push("cesium install");
    }
    return { home, checks, repairs, next, exitCode: 1 };
  }

  checks.push(ok("install", "install", `managed engine at ${home}`));

  if (applyFixes) {
    for (const dir of [logsDir, runDir, path.join(home, "bin")]) {
      if (!fileExists(dir)) {
        mkdirSync(dir, { recursive: true });
        repairs.push(`created ${dir}`);
      }
    }
  } else if (!fileExists(logsDir) || !fileExists(runDir)) {
    checks.push(warn("layout", "layout", "logs/ or run/ is missing", "Re-run `cesium doctor` (safe repairs) or `cesium install`."));
  }

  if (fileExists(envPath)) {
    try {
      const mode = statSync(envPath).mode & 0o777;
      if (mode & 0o077) {
        if (applyFixes) {
          chmodSync(envPath, 0o600);
          repairs.push("restricted server.env to mode 600");
        } else {
          checks.push(warn("env-perms", "server.env", `mode ${mode.toString(8)} is too open`, "chmod 600 the env file"));
        }
      }
    } catch {
      // ignore
    }
  }

  if (fileExists(manager) && !isExecutable(manager) && applyFixes) {
    chmodSync(manager, 0o700);
    repairs.push("marked bin/cesium-server executable");
  }

  let env = {};
  try {
    env = parseEnvFile(readFileSync(envPath, "utf8"));
  } catch (error) {
    checks.push(fail("env", "server.env", `could not parse: ${error?.message ?? error}`));
    return { home, checks, repairs, next, exitCode: 1 };
  }

  const sourceDir = env.CESIUM_SOURCE_DIR || path.join(home, "source");
  const bunBin = env.CESIUM_BUN_BIN || path.join(home, "runtime/bin/bun");
  const host = env.HOST || "127.0.0.1";
  const port = Number(env.PORT || "9100");
  const localUrl = `http://${host}:${port}`;
  const serverPidFile = path.join(runDir, "server.pid");
  const tunnelPidFile = path.join(runDir, "tunnel.pid");
  const supervisorPidFile = path.join(runDir, "supervisor.pid");
  const publicUrlFile = path.join(runDir, "public-url");
  const rendezvousStatusFile = path.join(runDir, "rendezvous-status");
  const rendezvousErrorFile = path.join(runDir, "rendezvous-error");
  const serverLog = path.join(logsDir, "server.log");
  const tunnelLog = path.join(logsDir, "tunnel.log");
  const rendezvousLog = path.join(logsDir, "rendezvous.log");

  if (fileExists(path.join(sourceDir, "server/src/runtime/bun-server.ts"))) {
    checks.push(ok("source", "source", sourceDir));
  } else {
    checks.push(
      fail("source", "source", `engine source missing at ${sourceDir}`, "cesium install --from-source <checkout>  or  cesium update")
    );
  }

  if (fileExists(manager) && fileExists(path.join(sourceDir, "scripts/cesium-server")) && applyFixes) {
    try {
      const installedManager = readFileSync(manager, "utf8");
      const sourceManager = readFileSync(path.join(sourceDir, "scripts/cesium-server"), "utf8");
      if (!installedManager.includes("wait_for_health") && sourceManager.includes("wait_for_health")) {
        writeFileSync(manager, sourceManager, { mode: 0o700 });
        repairs.push("restored bin/cesium-server from source");
      }
    } catch {
      // leave the installed manager alone
    }
  }

  if (fileExists(bunBin) && isExecutable(bunBin)) {
    checks.push(ok("runtime", "runtime", `bun at ${bunBin}`));
  } else {
    const pathBun = (() => {
      try {
        return execFileSync("bash", ["-lc", "command -v bun"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        return "";
      }
    })();
    if (pathBun && applyFixes) {
      mkdirSync(path.dirname(bunBin), { recursive: true });
      try {
        execFileSync("cp", [pathBun, bunBin]);
        chmodSync(bunBin, 0o700);
        repairs.push(`copied bun from ${pathBun}`);
        checks.push(ok("runtime", "runtime", `restored bun at ${bunBin}`));
      } catch {
        checks.push(fail("runtime", "runtime", `Bun missing at ${bunBin}`, "cesium install"));
      }
    } else {
      checks.push(fail("runtime", "runtime", `Bun missing at ${bunBin}`, "cesium install"));
    }
  }

  const workspace = env.WORKSPACE_ROOT;
  if (workspace && fileExists(workspace)) {
    checks.push(ok("workspace", "workspace", workspace));
  } else if (workspace) {
    checks.push(fail("workspace", "workspace", `WORKSPACE_ROOT does not exist: ${workspace}`));
  }

  if (hasSecret(env.OPENCURSOR_AUTH_USERNAME) && hasSecret(env.OPENCURSOR_AUTH_PASSWORD)) {
    checks.push(ok("auth", "engine auth", `username ${env.OPENCURSOR_AUTH_USERNAME} (password present, not printed)`));
  } else {
    checks.push(
      warn(
        "auth",
        "engine auth",
        "username/password not set — anyone who can reach the port can use the engine",
        "cesium credentials   or reinstall to generate a password"
      )
    );
  }

  function sweepStalePid(file, expectedNeedle, label) {
    const pid = readPid(file);
    if (pid == null) {
      return { running: false, pid: null, command: "" };
    }
    const alive = processIsAlive(pid);
    const command = alive ? processCommand(pid) : "";
    const matches = Boolean(expectedNeedle) && command.includes(expectedNeedle);
    if (!alive || (expectedNeedle && !matches)) {
      if (applyFixes) {
        try {
          unlinkSync(file);
          repairs.push(`removed stale ${label} pid file (${pid})`);
        } catch {
          // ignore
        }
      } else {
        checks.push(warn(`${label}-pid`, label, `stale pid ${pid} in ${file}`));
      }
      return { running: false, pid, command };
    }
    return { running: true, pid, command };
  }

  const serverProc = sweepStalePid(serverPidFile, "bun-server.ts", "engine");
  const supervisorProc = sweepStalePid(supervisorPidFile, "supervise", "supervisor");
  const tunnelProc = sweepStalePid(tunnelPidFile, "", "tunnel");

  if (supervisorProc.running) {
    checks.push(ok("lifecycle", "lifecycle", `supervisor pid ${supervisorProc.pid} (${env.CESIUM_SERVICE_MANAGER || "detached"})`));
  } else {
    checks.push(
      warn(
        "lifecycle",
        "lifecycle",
        "supervisor is not running",
        "CLI-only: `cesium start` keeps the engine up without the desktop app"
      )
    );
  }

  const portOpen = Number.isInteger(port) ? await probePort(host, port) : false;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    checks.push(fail("port", "port", `invalid PORT=${env.PORT}`));
  } else if (portOpen) {
    checks.push(ok("port", "port", `${host}:${port} is accepting connections`));
  } else if (serverProc.running) {
    checks.push(warn("port", "port", `pid ${serverProc.pid} is alive but ${host}:${port} is closed`));
  } else {
    checks.push(fail("port", "port", `${host}:${port} is not listening`, "cesium start"));
    next.push("cesium start");
  }

  const health = await fetchText(`${localUrl}/health`);
  if (health.ok && lookLikeCesiumHealth(health.body)) {
    checks.push(ok("engine", "engine", `healthy at ${localUrl}/health`));
  } else if (health.status && lookLikeCesiumHealth(health.body) === false && health.body) {
    checks.push(
      fail(
        "engine",
        "engine",
        `something is on ${host}:${port} but it is not a Cesium /health` +
          ` (HTTP ${health.status})`,
        "Stop the other process or set CESIUM_PORT and reinstall."
      )
    );
  } else if (health.status) {
    checks.push(
      fail(
        "engine",
        "engine",
        `${localUrl}/health returned HTTP ${health.status}`,
        "cesium logs server"
      )
    );
  } else if (portOpen) {
    checks.push(
      fail(
        "engine",
        "engine",
        `something is on ${host}:${port} but it is not a Cesium /health` +
          (health.error ? ` (${health.error})` : health.status ? ` HTTP ${health.status}` : ""),
        "Stop the other process or set CESIUM_PORT and reinstall."
      )
    );
  } else {
    checks.push(fail("engine", "engine", "engine is not serving /health", "cesium start"));
  }

  const serverTail = tailLines(serverLog, LOG_TAIL_LINES);
  if (serverTail) {
    const noisy = /error|fatal|EADDRINUSE|cannot find module|unhandled/i.test(serverTail);
    checks.push(
      (noisy ? warn : ok)(
        "logs",
        "logs",
        noisy ? "recent server log looks unhappy (tail below)" : `last ${LOG_TAIL_LINES} lines of server.log (tail below)`
      )
    );
  } else {
    checks.push(skip("logs", "logs", "no server.log yet"));
  }

  const tunnelEnabled = env.CESIUM_TUNNEL_ENABLED === "1";
  if (!tunnelEnabled) {
    checks.push(
      skip(
        "tunnel",
        "tunnel",
        "not configured — CLI-only / local engine",
        "Pass --web-url on install when a browser or phone needs to find this machine."
      )
    );
  } else if (env.CESIUM_BACKEND_MANAGES_PUBLIC_ACCESS === "1" && fileExists(path.join(runDir, "backend-public-access-disabled"))) {
    checks.push(ok("tunnel", "tunnel", "disabled in Cesium settings"));
  } else if (tunnelProc.running) {
    const publicUrl = fileExists(publicUrlFile) ? readFileSync(publicUrlFile, "utf8").trim() : "";
    if (publicUrl.startsWith("https://")) {
      const remoteHealth = await fetchHttpsHead(`${publicUrl.replace(/\/$/, "")}/health`, 4000);
      if (remoteHealth.ok && lookLikeCesiumHealth(remoteHealth.body)) {
        checks.push(ok("tunnel", "tunnel", `up, public health ok (${publicUrl})`));
      } else {
        checks.push(
          warn(
            "tunnel",
            "tunnel",
            `process is up but public /health failed${publicUrl ? ` (${publicUrl})` : ""}`,
            "cesium logs tunnel"
          )
        );
      }
    } else {
      checks.push(warn("tunnel", "tunnel", "tunnel process is up but no public URL yet", "cesium logs tunnel"));
    }
  } else {
    checks.push(fail("tunnel", "tunnel", "tunnel required but not running", "cesium start   then   cesium logs tunnel"));
  }

  const rendezvousUrl = env.CESIUM_RENDEZVOUS_URL;
  if (!rendezvousUrl) {
    checks.push(
      skip(
        "rendezvous",
        "pairing",
        "no rendezvous URL — this engine will not advertise itself to a web client",
        "cesium install --web-url https://your.cesium.host"
      )
    );
  } else {
    const helper = path.join(sourceDir, "scripts/cesium-rendezvous.mjs");
    if (!fileExists(helper)) {
      checks.push(fail("rendezvous", "pairing", `helper missing: ${helper}`, "cesium update"));
    }
    const remote = await fetchHttpsHead(rendezvousUrl, 4000);
    if (remote.status === 0) {
      checks.push(
        fail(
          "rendezvous-net",
          "pairing endpoint",
          `cannot reach ${rendezvousUrl}: ${remote.error || "network error"}`,
          "Check CESIUM_WEB_URL / CESIUM_RENDEZVOUS_URL and DNS."
        )
      );
    } else {
      checks.push(ok("rendezvous-net", "pairing endpoint", `${rendezvousUrl} responded HTTP ${remote.status}`));
    }
    if (fileExists(rendezvousErrorFile)) {
      const err = readFileSync(rendezvousErrorFile, "utf8").trim().slice(0, 240);
      checks.push(fail("rendezvous", "pairing", err || "rendezvous-error present", "cesium logs rendezvous"));
    } else if (fileExists(rendezvousStatusFile)) {
      const statusLine = readFileSync(rendezvousStatusFile, "utf8").trim();
      const publishedAt = Number(statusLine.split("\t")[0]);
      const age = Number.isFinite(publishedAt) ? Math.round(Date.now() / 1000 - publishedAt) : null;
      if (age != null && age < 75) {
        checks.push(ok("rendezvous", "pairing", `published ${age}s ago`));
      } else {
        checks.push(warn("rendezvous", "pairing", `last publish ${age ?? "?"}s ago (stale if the supervisor is down)`));
      }
    } else {
      checks.push(warn("rendezvous", "pairing", "configured, but nothing published yet", "cesium start"));
    }
  }

  const webUrl = env.CESIUM_WEB_URL;
  if (webUrl) {
    const web = await fetchHttpsHead(webUrl, 4000);
    if (web.status === 0) {
      checks.push(warn("web", "web deploy", `CESIUM_WEB_URL ${webUrl} is unreachable (${web.error || "network"})`));
    } else {
      checks.push(ok("web", "web deploy", `${webUrl} responded HTTP ${web.status}`));
    }
  } else {
    checks.push(skip("web", "web deploy", "unset — this machine is a CLI-only engine"));
  }

  const clientEnv = {
    ...parseDotEnv(path.join(sourceDir, ".env.local")),
    ...parseDotEnv(path.join(sourceDir, ".env")),
    ...process.env,
  };
  const defaults = parseCloudDefaults(sourceDir);
  const convex =
    clientEnv.NEXT_PUBLIC_CONVEX_URL?.trim() ||
    defaults?.convexUrl?.trim() ||
    "";
  const clerkPub =
    clientEnv.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() ||
    defaults?.clerkPublishableKey?.trim() ||
    "";
  const clerkSecretSet = hasSecret(clientEnv.CLERK_SECRET_KEY);
  const cloudOff = clientEnv.NEXT_PUBLIC_CESIUM_CLOUD === "0";

  if (cloudOff) {
    checks.push(ok("cloud", "Clerk / Convex", "NEXT_PUBLIC_CESIUM_CLOUD=0 — clients stay local-only"));
  } else if (!convex && !clerkPub) {
    checks.push(
      skip(
        "cloud",
        "Clerk / Convex",
        "no Convex URL or Clerk publishable key on this host (empty cloud-defaults + no env)",
        "That is fine for a CLI-only engine. Configure these on the web deploy, not here."
      )
    );
  } else {
    const bits = [];
    bits.push(convex ? "Convex URL present" : "Convex URL missing");
    bits.push(clerkPub ? "Clerk publishable key present" : "Clerk publishable key missing");
    if (clerkPub && !clerkSecretSet && webUrl) {
      bits.push("CLERK_SECRET_KEY unset on this machine (expected unless this host is the web deploy)");
    }
    const broken = Boolean(clerkPub && !convex) || Boolean(convex && !clerkPub && webUrl);
    checks.push(
      (broken ? warn : ok)(
        "cloud",
        "Clerk / Convex",
        bits.join("; "),
        broken ? "Set both NEXT_PUBLIC_CONVEX_URL and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY on the web deploy." : undefined
      )
    );
  }

  if (tunnelEnabled) {
    const tunnelTail = tailLines(tunnelLog, 8);
    if (/error|failed|refused/i.test(tunnelTail)) {
      checks.push(warn("tunnel-log", "tunnel log", "recent tunnel log mentions an error — tail below"));
    }
  }

  const failed = checks.some((check) => check.status === "fail");
  if (failed && !next.includes("cesium start") && !health.ok) {
    next.push("cesium start");
  }
  if (failed) {
    next.push("cesium logs server");
    next.push("cesium doctor --json");
  }

  return {
    home,
    localUrl,
    envKeys: Object.keys(env),
    tails: {
      server: serverTail,
      tunnel: tunnelEnabled ? tailLines(tunnelLog, 12) : "",
      rendezvous: rendezvousUrl ? tailLines(rendezvousLog, 12) : "",
    },
    checks,
    repairs,
    next: [...new Set(next)],
    exitCode: failed ? 1 : 0,
  };
}

function padStatus(status) {
  return status.padEnd(4, " ");
}

export function formatDoctorReport(report) {
  const lines = [`cesium doctor — ${report.home}`, ""];
  for (const check of report.checks) {
    const row = `  ${padStatus(check.status)}  ${check.title.padEnd(18, " ")} ${check.detail}`;
    lines.push(row);
    if (check.hint) {
      lines.push(`          → ${check.hint}`);
    }
  }
  if (report.repairs.length) {
    lines.push("", "Repairs applied:");
    for (const repair of report.repairs) {
      lines.push(`  - ${repair}`);
    }
  }
  if (report.tails?.server) {
    lines.push("", "--- server.log (tail) ---", report.tails.server);
  }
  if (report.tails?.tunnel) {
    lines.push("", "--- tunnel.log (tail) ---", report.tails.tunnel);
  }
  if (report.tails?.rendezvous) {
    lines.push("", "--- rendezvous.log (tail) ---", report.tails.rendezvous);
  }
  if (report.next.length) {
    lines.push("", "Next:");
    for (const step of report.next) {
      lines.push(`  ${step}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function doctorExitCode(report) {
  return report.exitCode;
}

export function parseDoctorArgs(args) {
  let applyFixes = true;
  let json = false;
  for (const arg of args) {
    if (arg === "--check" || arg === "--no-fix") {
      applyFixes = false;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--fix") {
      applyFixes = true;
    } else {
      throw new Error(`Unknown doctor option: ${arg}`);
    }
  }
  return { applyFixes, json };
}

#!/usr/bin/env bun
/**
 * CLI half of the one-link account pairing, driven by `cesium-server`.
 *
 *   cesium-connect.mjs start            -> mints a pairing on the local engine, prints JSON
 *   cesium-connect.mjs wait <code> [s]  -> polls until attached / expired / timeout, prints JSON
 *   cesium-connect.mjs qr <text>        -> prints a terminal QR code
 *
 * Talks only to the local engine (`http://HOST:PORT`), authenticating with the
 * installer-provisioned OPENCURSOR_AUTH_USERNAME/PASSWORD from server.env. The
 * engine does the cloud registration; this script never sees the account.
 */
import { encodeQr, renderQrHalfBlocks } from "./cesium-qr.mjs";

const host = process.env.HOST?.trim() || "127.0.0.1";
const port = process.env.PORT?.trim() || "9100";
const localUrl = process.env.CESIUM_LOCAL_URL?.trim() || `http://${host}:${port}`;

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

async function login() {
  const username = process.env.OPENCURSOR_AUTH_USERNAME?.trim();
  const password = process.env.OPENCURSOR_AUTH_PASSWORD?.trim();
  if (!username || !password) {
    fail("Engine authentication is not configured; run the installer again.");
  }
  const response = await fetch(`${localUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, remember: false }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    fail(`Local engine login failed (${response.status}). Is the server running?`);
  }
  const payload = await response.json();
  if (typeof payload.token !== "string" || !payload.token) {
    fail("Local engine login did not return a session token.");
  }
  return payload.token;
}

async function engineRequest(path, init = {}, token) {
  const response = await fetch(`${localUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-opencursor-session-token": token,
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload.error === "string"
        ? payload.error
        : `Engine request failed (${response.status}).`;
    throw new Error(message);
  }
  return payload;
}

async function start() {
  const token = await login();
  const pairing = await engineRequest(
    "/api/public-access/pairing",
    { method: "POST", body: JSON.stringify({}) },
    token
  );
  process.stdout.write(
    `${JSON.stringify({
      code: pairing.code,
      connectUrl: pairing.connectUrl,
      fingerprint: pairing.fingerprint,
      label: pairing.label,
      publicUrl: pairing.publicUrl,
      expiresAt: pairing.expiresAt,
    })}\n`
  );
}

async function wait(code, timeoutSeconds) {
  if (!code) fail("Usage: cesium-connect.mjs wait <code> [timeoutSeconds]", 2);
  const timeoutMs = Math.max(5, Number.parseInt(timeoutSeconds ?? "600", 10) || 600) * 1000;
  const token = await login();
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  while (Date.now() < deadline) {
    let view;
    try {
      view = await engineRequest(
        `/api/public-access/pairing/${encodeURIComponent(code)}`,
        {},
        token
      );
    } catch (error) {
      // A restarting engine loses in-memory pairings; report and stop.
      fail(error instanceof Error ? error.message : String(error), 3);
    }
    if (view.status !== lastStatus) {
      lastStatus = view.status;
      if (view.status === "claimed") {
        console.error("Link opened - finishing the attach...");
      }
    }
    if (view.status === "attached" || view.status === "claimed") {
      // "claimed" means the browser already holds the credential; the cloud
      // confirmation normally follows within seconds. Give it a moment so the
      // account email can be shown, then report either way.
      if (view.status === "claimed" && Date.now() < deadline) {
        const settle = Date.now() + 20_000;
        while (Date.now() < settle && view.status === "claimed") {
          await Bun.sleep(2000);
          view = await engineRequest(
            `/api/public-access/pairing/${encodeURIComponent(code)}`,
            {},
            token
          );
        }
      }
      process.stdout.write(
        `${JSON.stringify({
          status: view.status,
          account: view.attachedBy ?? view.claimedBy ?? null,
        })}\n`
      );
      return;
    }
    if (view.status === "expired" || view.status === "cancelled") {
      process.stdout.write(`${JSON.stringify({ status: view.status, account: null })}\n`);
      process.exit(3);
    }
    await Bun.sleep(3000);
  }
  process.stdout.write(`${JSON.stringify({ status: "timeout", account: null })}\n`);
  process.exit(4);
}

const [action, ...rest] = process.argv.slice(2);
try {
  if (action === "start") {
    await start();
  } else if (action === "wait") {
    await wait(rest[0], rest[1]);
  } else if (action === "qr" && rest[0]) {
    process.stdout.write(`${renderQrHalfBlocks(encodeQr(rest[0], "L"))}\n`);
  } else {
    fail("Usage: cesium-connect.mjs {start|wait <code> [timeoutSeconds]|qr <text>}", 2);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

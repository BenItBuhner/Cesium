import assert from "node:assert/strict";
import { test } from "node:test";
import {
  enableTailscaleAccess,
  extractTailscaleHttpsUrl,
  formatTailscaleDoctorLine,
  normalizeTailscaleExpose,
  parseTailscaleServeStatus,
  parseTailscaleStatusJson,
  probeTailscale,
  tailscaleHttpsUrlFromDnsName,
  type TailscaleCommandResult,
} from "../src/lib/tailscale-access.js";

const STATUS_RUNNING = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "home.tail123.ts.net." },
});

const SERVE_OUR_PORT = JSON.stringify({
  TCP: { "443": { HTTPS: true } },
  Web: {
    "home.tail123.ts.net:443": {
      Handlers: { "/": { Proxy: "http://127.0.0.1:9100" } },
    },
  },
});

const SERVE_OTHER_PORT = JSON.stringify({
  Web: {
    "home.tail123.ts.net:443": {
      Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } },
    },
  },
});

function scriptedRun(
  responses: Record<string, TailscaleCommandResult>
): (command: string, args: string[]) => Promise<TailscaleCommandResult> {
  return async (_command, args) => {
    const key = args.join(" ");
    const hit = responses[key];
    if (!hit) {
      throw new Error(`unexpected tailscale args: ${key}`);
    }
    return hit;
  };
}

test("MagicDNS names become HTTPS URLs and ignore junk", () => {
  assert.equal(
    tailscaleHttpsUrlFromDnsName("home.tail123.ts.net."),
    "https://home.tail123.ts.net"
  );
  assert.equal(tailscaleHttpsUrlFromDnsName("https://evil.example"), null);
  assert.equal(
    extractTailscaleHttpsUrl("Available within your tailnet:\nhttps://home.tail123.ts.net\n"),
    "https://home.tail123.ts.net"
  );
});

test("expose mode stays opt-in and rejects unknown values", () => {
  assert.equal(normalizeTailscaleExpose(undefined), "tailnet");
  assert.equal(normalizeTailscaleExpose("funnel"), "funnel");
  assert.throws(() => normalizeTailscaleExpose("public"), /tailnet or funnel/);
});

test("status JSON reports login state without requiring a live daemon", () => {
  assert.deepEqual(parseTailscaleStatusJson(STATUS_RUNNING), {
    backendState: "Running",
    dnsName: "home.tail123.ts.net.",
    httpsUrl: "https://home.tail123.ts.net",
  });
  assert.equal(parseTailscaleStatusJson(JSON.stringify({ BackendState: "NeedsLogin" })).backendState, "NeedsLogin");
});

test("serve status detects our port, foreign mappings, and empty config", () => {
  assert.deepEqual(parseTailscaleServeStatus("No serve config", 9100), {
    serving: false,
    servingOurPort: false,
    expose: null,
    httpsUrl: null,
  });
  const ours = parseTailscaleServeStatus(SERVE_OUR_PORT, 9100);
  assert.equal(ours.serving, true);
  assert.equal(ours.servingOurPort, true);
  assert.equal(ours.httpsUrl, "https://home.tail123.ts.net");
  const other = parseTailscaleServeStatus(SERVE_OTHER_PORT, 9100);
  assert.equal(other.servingOurPort, false);
  assert.equal(other.serving, true);
});

test("probe reports missing CLI, needs-login, and ready-not-serving", async () => {
  const missing = await probeTailscale({
    findExecutable: async () => null,
  });
  assert.equal(missing.installed, false);
  assert.match(formatTailscaleDoctorLine(missing), /not installed/);

  const loggedOut = await probeTailscale({
    findExecutable: async () => "/usr/bin/tailscale",
    runCommand: scriptedRun({
      "status --json": {
        code: 0,
        stdout: JSON.stringify({ BackendState: "NeedsLogin" }),
        stderr: "",
      },
    }),
  });
  assert.equal(loggedOut.installed, true);
  assert.equal(loggedOut.loggedIn, false);
  assert.match(formatTailscaleDoctorLine(loggedOut), /needs login/);

  const ready = await probeTailscale({
    findExecutable: async () => "/usr/bin/tailscale",
    localPort: 9100,
    runCommand: scriptedRun({
      "status --json": { code: 0, stdout: STATUS_RUNNING, stderr: "" },
      "serve status --json": { code: 0, stdout: "No serve config\n", stderr: "" },
    }),
  });
  assert.equal(ready.loggedIn, true);
  assert.equal(ready.serving, false);
  assert.match(formatTailscaleDoctorLine(ready), /ready \(https:\/\/home\.tail123\.ts\.net\)/);
});

test("enable reuses an existing Serve mapping for this engine port", async () => {
  const result = await enableTailscaleAccess({
    findExecutable: async () => "/usr/bin/tailscale",
    localPort: 9100,
    runCommand: scriptedRun({
      "status --json": { code: 0, stdout: STATUS_RUNNING, stderr: "" },
      "serve status --json": { code: 0, stdout: SERVE_OUR_PORT, stderr: "" },
    }),
  });
  assert.equal(result.url, "https://home.tail123.ts.net");
});

test("enable refuses to clobber a foreign Serve mapping", async () => {
  await assert.rejects(
    () =>
      enableTailscaleAccess({
        findExecutable: async () => "/usr/bin/tailscale",
        localPort: 9100,
        runCommand: scriptedRun({
          "status --json": { code: 0, stdout: STATUS_RUNNING, stderr: "" },
          "serve status --json": { code: 0, stdout: SERVE_OTHER_PORT, stderr: "" },
        }),
      }),
    /already publishing a different local service/
  );
});

test("enable configures Serve when nothing is published yet", async () => {
  let configured = false;
  const result = await enableTailscaleAccess({
    findExecutable: async () => "/usr/bin/tailscale",
    localPort: 9100,
    expose: "tailnet",
    runCommand: async (_command, args) => {
      const key = args.join(" ");
      if (key === "status --json") {
        return { code: 0, stdout: STATUS_RUNNING, stderr: "" };
      }
      if (key === "serve status --json") {
        return {
          code: 0,
          stdout: configured ? SERVE_OUR_PORT : "No serve config\n",
          stderr: "",
        };
      }
      if (key === "serve --bg --yes 9100") {
        configured = true;
        return {
          code: 0,
          stdout: "Available within your tailnet:\nhttps://home.tail123.ts.net\n",
          stderr: "",
        };
      }
      throw new Error(`unexpected ${key}`);
    },
  });
  assert.equal(result.url, "https://home.tail123.ts.net");
  assert.equal(configured, true);
});

test("enable fails closed when Tailscale is missing so other tunnels stay default", async () => {
  await assert.rejects(
    () =>
      enableTailscaleAccess({
        findExecutable: async () => null,
      }),
    /not installed/
  );
});

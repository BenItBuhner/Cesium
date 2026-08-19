import { execSync } from "node:child_process";

/**
 * Scripted walkthrough of the Cesium Desktop native-integration features,
 * driven over the Chrome DevTools Protocol against a running instance
 * launched with `--remote-debugging-port`. Needs no OS-level input
 * permissions (no AppleScript/Accessibility on macOS), so it runs on stock
 * CI runners; pair it with OPENCURSOR_DESKTOP_CAPTURE_INTERVAL_MS frame
 * capture to film the run.
 *
 * Env:
 * - CESIUM_DEMO_CDP_PORT      (default 9222)
 * - CESIUM_DEMO_SHARE_CMD     shell command that triggers an OS file share
 *                             (e.g. `open -a "…app" file.md` on macOS)
 * - CESIUM_DEMO_DEEPLINK_CMD  shell command that opens a cesium:// URL
 */

const port = process.env.CESIUM_DEMO_CDP_PORT || "9222";
const shareCmd = process.env.CESIUM_DEMO_SHARE_CMD || "";
const deeplinkCmd = process.env.CESIUM_DEMO_DEEPLINK_CMD || "";

// Hard watchdog: a dead CDP socket or a stuck OS dialog must fail the demo,
// never hang the CI job until its own timeout.
const WATCHDOG_MS = 8 * 60_000;
const watchdog = setTimeout(() => {
  console.error("[desktop-demo] FAILED: watchdog expired after 8 minutes");
  process.exit(1);
}, WATCHDOG_MS);
// unref'd: never keeps a finished demo alive, still fires while the CDP
// socket (or anything else) keeps the process running.
watchdog.unref?.();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
  console.log(`[desktop-demo] ${message}`);
}

async function findPageTarget() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find(
        (t) =>
          t.type === "page" &&
          !String(t.url).startsWith("devtools://") &&
          t.webSocketDebuggerUrl
      );
      if (page) {
        return page;
      }
    } catch {
      // App not listening yet.
    }
    await sleep(500);
  }
  throw new Error(`No CDP page target on port ${port} after 60s.`);
}

let ws;
let nextId = 0;
const pending = new Map();

async function connect(page) {
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id != null && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        reject(new Error(message.error.message));
      } else {
        resolve(message.result);
      }
    }
  });
}

function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        reject(new Error(`CDP ${method} timed out after 30s`));
      }
    }, 30_000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      `Evaluate failed: ${result.exceptionDetails.text} ${
        result.exceptionDetails.exception?.description ?? ""
      }`
    );
  }
  return result.result?.value;
}

async function waitFor(description, expression, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) {
      log(`ready: ${description}`);
      return;
    }
    await sleep(400);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

/** Click the first element matching `selector` whose text includes `text`. */
function clickByTextExpr(selector, text) {
  return `(() => {
    const needle = ${JSON.stringify(text)}.toLowerCase();
    for (const el of document.querySelectorAll(${JSON.stringify(selector)})) {
      if ((el.textContent || "").toLowerCase().includes(needle)) {
        el.click();
        return true;
      }
    }
    return false;
  })()`;
}

function runShellCommand(label, command) {
  log(`running ${label}: ${command}`);
  execSync(command, { stdio: "inherit", timeout: 60_000 });
}

async function main() {
  const page = await findPageTarget();
  log(`attached to ${page.url}`);
  await connect(page);
  await send("Runtime.enable");

  // 1. Workbench ready (composer input mounted).
  await waitFor(
    "workbench composer",
    `!!document.querySelector('textarea, [contenteditable="true"]')`,
    90_000
  );
  await sleep(2_500);

  // 2. Open Settings from the rail.
  await waitFor(
    "settings button",
    `!!document.querySelector('button[aria-label="Open settings"]')`
  );
  await evaluate(`document.querySelector('button[aria-label="Open settings"]').click()`);
  await waitFor(
    "settings shell",
    `!!document.querySelector('button[aria-label="Back to Agents"]')`
  );
  await sleep(1_000);

  // 3. General panel -> scroll the desktop notifications section into view.
  await evaluate(clickByTextExpr("button", "General"));
  await waitFor(
    "desktop notifications section",
    `!!document.querySelector('[data-settings-search-id="desktop-notification-test"]')`
  );
  await evaluate(
    `document.querySelector('[data-settings-search-id="desktop-notification-test"]').scrollIntoView({ block: "center", behavior: "smooth" })`
  );
  await sleep(2_000);

  // 4. Send a native test notification.
  await evaluate(
    `document.querySelector('[data-settings-search-id="desktop-notification-test"] button').click()`
  );
  log("clicked Send test notification");
  await sleep(3_000);

  // 5. Back to the workbench.
  await evaluate(`document.querySelector('button[aria-label="Back to Agents"]').click()`);
  await sleep(2_000);

  // 6. OS file share -> Share to Cesium sheet -> New chat.
  if (shareCmd) {
    runShellCommand("share command", shareCmd);
    await waitFor(
      "share sheet (file)",
      `!!document.querySelector('div[aria-label="Share to Cesium"]')`,
      45_000
    );
    await sleep(2_000);
    await evaluate(clickByTextExpr('div[aria-label="Share to Cesium"] button', "New chat"));
    await waitFor(
      "share sheet dismissed",
      `!document.querySelector('div[aria-label="Share to Cesium"]')`,
      30_000
    );
    log("file share staged into a new chat");
    await sleep(2_500);
  }

  // 7. cesium:// deep link -> Share to Cesium sheet -> New chat.
  if (deeplinkCmd) {
    runShellCommand("deep link command", deeplinkCmd);
    await waitFor(
      "share sheet (deep link)",
      `!!document.querySelector('div[aria-label="Share to Cesium"]')`,
      45_000
    );
    await sleep(2_000);
    await evaluate(clickByTextExpr('div[aria-label="Share to Cesium"] button', "New chat"));
    await waitFor(
      "share sheet dismissed again",
      `!document.querySelector('div[aria-label="Share to Cesium"]')`,
      30_000
    );
    log("deep link text staged into the composer");
    await sleep(3_000);
  }

  log("demo complete");
  ws.close();
}

main().catch((error) => {
  console.error(`[desktop-demo] FAILED: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});

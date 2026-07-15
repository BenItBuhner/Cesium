import "./env-bootstrap.js";
import {
  startDesktopQuickHealthListener,
  stopDesktopQuickHealthListener,
} from "./desktop-quick-health.js";

// Single place to swallow transient async failures from WS handlers,
// `postgres` pool blips, `ioredis` reconnects, etc. Without these, one
// unhandled Promise rejection (e.g. a CONNECT_TIMEOUT while a user is typing
// in a chat) terminates the whole server. We log loudly instead.
process.on("unhandledRejection", (reason) => {
  console.error("[process] unhandledRejection:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("[process] uncaughtException:", error);
});

function startDesktopParentWatchdog(): void {
  if (process.env.OPENCURSOR_DESKTOP_BACKEND !== "1") {
    return;
  }
  // Electron-as-Node can otherwise exit after startup if the HTTP server is not
  // enough to anchor the event loop. The desktop sidecar must live with parent.
  setInterval(() => undefined, 60_000);
  const parentPid = Number.parseInt(
    process.env.OPENCURSOR_DESKTOP_PARENT_PID ?? "",
    10
  );
  if (!Number.isFinite(parentPid) || parentPid <= 0) {
    return;
  }

  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      console.warn("[desktop] parent process disappeared; exiting backend.");
      process.exit(0);
    }
  }, 2_000);
}

async function boot(): Promise<void> {
  await startDesktopQuickHealthListener();
  startDesktopParentWatchdog();
  const { startNodeServer } = await import("./runtime/node-server.js");
  await stopDesktopQuickHealthListener();
  startNodeServer();
}

boot().catch((error) => {
  console.error("[process] failed to start server:", error);
  process.exit(1);
});

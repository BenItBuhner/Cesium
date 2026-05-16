import "./env-bootstrap.js";
import { startNodeServer } from "./runtime/node-server.js";

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
  const parentPid = Number.parseInt(
    process.env.OPENCURSOR_DESKTOP_PARENT_PID ?? "",
    10
  );
  if (!Number.isFinite(parentPid) || parentPid <= 0) {
    return;
  }

  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      console.warn("[desktop] parent process disappeared; exiting backend.");
      process.exit(0);
    }
  }, 2_000);
  timer.unref();
}

startDesktopParentWatchdog();
startNodeServer();

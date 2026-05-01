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
startNodeServer();

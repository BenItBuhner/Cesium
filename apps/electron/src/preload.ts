import { contextBridge } from "electron";

function readServerUrlFromArgv(): string | null {
  const arg = process.argv.find((value) => value.startsWith("--opencursor-server-url="));
  if (!arg) {
    return null;
  }
  const value = arg.slice("--opencursor-server-url=".length).trim();
  return value.length > 0 ? value : null;
}

contextBridge.exposeInMainWorld("__OPENCURSOR_RUNTIME_CONFIG__", {
  serverUrl: readServerUrlFromArgv() ?? "http://localhost:9100",
  platform: "electron",
});

/**
 * @cesium/browser-machine - a fully in-browser Cesium engine.
 *
 * Loaded lazily by `@cesium/client` when the user selects the "This browser"
 * device: implements the engine's `/api/*` + `/ws/*` surface against a
 * virtual filesystem (IndexedDB), isomorphic-git, a built-in shell, and an
 * in-page Cesium agent harness.
 */
export {
  BrowserMachineEngine,
  createBrowserMachineTransport,
  getBrowserMachineEngine,
  type BrowserMachineTransport,
} from "./engine";
export { BrowserMachineWebSocket } from "./sockets";
export { Vfs, createPromisesFs } from "./vfs";
export { ShellRuntime } from "./shell/runtime";
export { BrowserGit, getStoredGithubToken, setStoredGithubToken } from "./git/browser-git";
export { buildBrowserMachineReminder } from "./harness/reminder";

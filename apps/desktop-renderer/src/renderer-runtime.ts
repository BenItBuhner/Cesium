import { initializeDesktopRuntime } from "./desktop-runtime";
import { initializeMobileRuntime } from "./mobile-runtime";

export async function initializeRendererRuntime() {
  await initializeDesktopRuntime();
  await initializeMobileRuntime();
}

const VITE_ASSETS_SEGMENT = "/assets/";

function bundledRendererRootUrl(moduleUrl: string): string | null {
  const assetsIndex = moduleUrl.lastIndexOf(VITE_ASSETS_SEGMENT);
  if (assetsIndex === -1) {
    return null;
  }
  return moduleUrl.slice(0, assetsIndex + 1);
}

type PublicAssetRuntime = {
  protocol?: string;
  locationHref?: string;
  moduleUrl?: string;
};

// Packaged Electron serves the renderer from file://. Resolve public assets from
// the bundled renderer root (`desktop-renderer/`), not the mutable SPA location,
// so history state like `/workspace` cannot turn icons into `file:///model-icons`.
export function resolvePublicAssetUrlForRuntime(
  path: `/${string}`,
  runtime: PublicAssetRuntime
): string {
  const trimmed = path.startsWith("/") ? path.slice(1) : path;
  if (runtime.protocol === "file:" && runtime.locationHref) {
    try {
      const rendererRoot = runtime.moduleUrl
        ? bundledRendererRootUrl(runtime.moduleUrl)
        : null;
      return new URL(trimmed, rendererRoot ?? runtime.locationHref).href;
    } catch {
      const prefix = path.startsWith("/") ? "." : "";
      return `${prefix}${path}`;
    }
  }
  return path;
}

export function publicAssetUrl(path: `/${string}`): string {
  return resolvePublicAssetUrlForRuntime(path, {
    protocol: typeof window !== "undefined" ? window.location.protocol : undefined,
    locationHref: typeof window !== "undefined" ? window.location.href : undefined,
    moduleUrl: import.meta.url,
  });
}

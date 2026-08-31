/**
 * Live preview for browser-machine workspaces.
 *
 * Built/static files are published into a Cache API bucket; a tiny service
 * worker (public/browser-machine-preview-sw.js) serves them under
 * `/preview/<workspaceId>/...` as a same-origin static site. `serve` and
 * `esbuild` shell commands give both agents and users a working
 * build-and-preview loop without any backend.
 */
import { basename, joinPath, toRelativePath } from "../paths";
import type { Vfs } from "../vfs";
import type { ShellRuntime } from "../shell/runtime";
import { resolvePath, type ShellContext } from "../shell/builtins";
import { inferMimeType } from "../lang";
import { bundleWithVfs } from "../build/esbuild-service";

export const PREVIEW_CACHE_NAME = "cesium-browser-machine-preview";
export const PREVIEW_SCOPE = "/preview/";
const PREVIEW_SW_PATH = "/browser-machine-preview-sw.js";

let registrationPromise: Promise<boolean> | null = null;

export function registerPreviewServiceWorker(): Promise<boolean> {
  if (!registrationPromise) {
    registrationPromise = (async () => {
      if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
        return false;
      }
      try {
        await navigator.serviceWorker.register(PREVIEW_SW_PATH, { scope: PREVIEW_SCOPE });
        return true;
      } catch (error) {
        console.warn("[browser-machine] preview service worker unavailable:", error);
        return false;
      }
    })();
  }
  return registrationPromise;
}

/** Publish a VFS directory as a static site under /preview/<slug>/. */
export async function publishPreview(input: {
  vfs: Vfs;
  dir: string;
  slug: string;
}): Promise<{ url: string; fileCount: number }> {
  if (typeof caches === "undefined") {
    throw new Error("The Cache API is unavailable; preview cannot be published.");
  }
  await registerPreviewServiceWorker();
  const cache = await caches.open(PREVIEW_CACHE_NAME);
  const origin = typeof location !== "undefined" ? location.origin : "";
  const base = `${origin}${PREVIEW_SCOPE}${input.slug}`;
  let fileCount = 0;

  const publishFile = async (path: string): Promise<void> => {
    const record = input.vfs.getRecord(path);
    if (!record || record.type !== "file") return;
    const relative = toRelativePath(input.dir, path);
    const bytes = record.data ?? new Uint8Array(0);
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);
    const response = new Response(body, {
      headers: {
        "content-type": inferMimeType(path),
        "cache-control": "no-store",
      },
    });
    await cache.put(`${base}/${relative}`, response.clone());
    fileCount += 1;
    if (basename(path) === "index.html") {
      const dirUrl = relative === "index.html" ? `${base}/` : `${base}/${relative.slice(0, -"index.html".length)}`;
      await cache.put(dirUrl, response.clone());
    }
  };

  const walk = async (dir: string): Promise<void> => {
    for (const child of input.vfs.listChildren(dir)) {
      if (child.type === "dir") {
        await walk(child.path);
      } else if (child.type === "file") {
        await publishFile(child.path);
      }
    }
  };
  await walk(input.dir);
  return { url: `${base}/`, fileCount };
}

export function registerPreviewCommands(shell: ShellRuntime, vfs: Vfs): void {
  shell.registerCommand("serve", async (argv: string[], ctx: ShellContext): Promise<number> => {
    const target = resolvePath(ctx, argv[0] ?? ".");
    const record = vfs.getRecord(target);
    if (!record || record.type !== "dir") {
      ctx.io.writeErr(`serve: ${argv[0] ?? "."}: not a directory\n`);
      return 1;
    }
    const slug = target
      .replace(/^\/+/, "")
      .replace(/[^\w.-]+/g, "-")
      .toLowerCase();
    try {
      const result = await publishPreview({ vfs, dir: target, slug });
      ctx.io.write(
        `Published ${result.fileCount} file${result.fileCount === 1 ? "" : "s"} to ${result.url}\nOpen that URL in a browser tab to view the site. Re-run serve after rebuilding.\n`
      );
      return 0;
    } catch (error) {
      ctx.io.writeErr(`serve: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  });

  shell.registerCommand("esbuild", async (argv: string[], ctx: ShellContext): Promise<number> => {
    let entry: string | null = null;
    let outfile: string | null = null;
    let minify = false;
    let format: "iife" | "esm" | "cjs" = "iife";
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i] as string;
      if (arg === "--minify") minify = true;
      else if (arg.startsWith("--outfile=")) outfile = arg.slice("--outfile=".length);
      else if (arg === "--outfile") outfile = argv[++i] ?? null;
      else if (arg.startsWith("--format=")) format = arg.slice("--format=".length) as typeof format;
      else if (arg === "--bundle") {
        // Bundling is always on.
      } else if (!arg.startsWith("-")) entry = arg;
    }
    if (!entry) {
      ctx.io.writeErr("esbuild: missing entry point\n");
      return 1;
    }
    const entryPoint = resolvePath(ctx, entry);
    if (!vfs.exists(entryPoint)) {
      ctx.io.writeErr(`esbuild: ${entry}: no such file\n`);
      return 1;
    }
    const result = await bundleWithVfs({
      vfs,
      projectDir: ctx.cwd.value,
      entryPoint,
      format,
      minify,
    });
    if (result.errors.length > 0) {
      for (const error of result.errors) {
        ctx.io.writeErr(`esbuild: error: ${error}\n`);
      }
      return 1;
    }
    for (const warning of result.warnings) {
      ctx.io.writeErr(`esbuild: warning: ${warning}\n`);
    }
    const outputBytes = result.outputs[0]?.bytes ?? new Uint8Array(0);
    const target = outfile
      ? resolvePath(ctx, outfile)
      : joinPath(ctx.cwd.value, "dist", basename(entryPoint).replace(/\.(tsx?|jsx)$/, ".js"));
    const parent = target.slice(0, target.lastIndexOf("/")) || "/";
    if (!vfs.exists(parent)) vfs.mkdir(parent, { recursive: true });
    vfs.writeFile(target, outputBytes.slice());
    ctx.io.write(`${toRelativePath(ctx.cwd.value, target) || target}  ${outputBytes.byteLength} bytes\n`);
    return 0;
  });
}

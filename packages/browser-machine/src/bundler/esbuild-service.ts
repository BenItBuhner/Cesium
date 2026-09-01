/**
 * esbuild-wasm bundling against the VFS: TypeScript/JSX transpilation,
 * node_modules resolution (exports/browser/module/main), and node builtin
 * shims for the `node` shell command.
 */
import type * as EsbuildTypes from "esbuild-wasm";
import { dirname, extname, joinPath, normalizePath } from "../paths";
import type { Vfs } from "../vfs";

const ESBUILD_VERSION = "0.27.7";

let esbuildPromise: Promise<typeof EsbuildTypes> | null = null;

async function resolveWasmUrl(): Promise<string> {
  const cdnUrl = `https://cdn.jsdelivr.net/npm/esbuild-wasm@${ESBUILD_VERSION}/esbuild.wasm`;
  if (typeof location === "undefined") return cdnUrl;
  // Prefer the same-origin copy (works on locked-down networks); fall back
  // to the CDN when the host deployment does not serve it.
  try {
    const probe = await fetch("/api/esbuild-wasm", { method: "GET" });
    if (probe.ok) {
      void probe.body?.cancel();
      return "/api/esbuild-wasm";
    }
  } catch {
    // fall through to CDN
  }
  return cdnUrl;
}

export async function getEsbuild(): Promise<typeof EsbuildTypes> {
  if (!esbuildPromise) {
    esbuildPromise = (async () => {
      const esbuild = await import("esbuild-wasm");
      await esbuild.initialize({
        wasmURL: await resolveWasmUrl(),
        worker: true,
      });
      return esbuild;
    })().catch((error) => {
      esbuildPromise = null;
      throw error;
    });
  }
  return esbuildPromise;
}

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

const NODE_BUILTINS = new Set([
  "assert",
  "buffer",
  "child_process",
  "crypto",
  "events",
  "fs",
  "http",
  "https",
  "module",
  "net",
  "os",
  "path",
  "process",
  "stream",
  "url",
  "util",
  "zlib",
]);

function loaderForPath(path: string): EsbuildTypes.Loader {
  switch (extname(path)) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "ts";
    case ".tsx":
      return "tsx";
    case ".jsx":
      return "jsx";
    case ".json":
      return "json";
    case ".css":
      return "css";
    case ".txt":
    case ".md":
      return "text";
    default:
      return "js";
  }
}

function tryFile(vfs: Vfs, path: string): string | null {
  const record = vfs.getRecord(path);
  if (record?.type === "file") return path;
  if (record?.type === "dir") {
    for (const extension of RESOLVE_EXTENSIONS) {
      const index = joinPath(path, `index${extension}`);
      if (vfs.getRecord(index)?.type === "file") return index;
    }
    // Directory with its own package.json main.
    const packageJsonPath = joinPath(path, "package.json");
    if (vfs.getRecord(packageJsonPath)?.type === "file") {
      try {
        const parsed = JSON.parse(vfs.readTextFile(packageJsonPath)) as {
          main?: string;
          module?: string;
        };
        const main = parsed.module ?? parsed.main;
        if (main) return tryFile(vfs, joinPath(path, main));
      } catch {
        return null;
      }
    }
    return null;
  }
  for (const extension of RESOLVE_EXTENSIONS) {
    if (vfs.getRecord(`${path}${extension}`)?.type === "file") return `${path}${extension}`;
  }
  return null;
}

type ExportsField =
  | string
  | string[]
  | { [condition: string]: ExportsField }
  | null;

function resolveExportsTarget(field: ExportsField): string | null {
  if (typeof field === "string") return field;
  if (Array.isArray(field)) {
    for (const entry of field) {
      const resolved = resolveExportsTarget(entry);
      if (resolved) return resolved;
    }
    return null;
  }
  if (field && typeof field === "object") {
    for (const condition of ["browser", "import", "module", "default", "require", "node"]) {
      if (condition in field) {
        const resolved = resolveExportsTarget(field[condition] ?? null);
        if (resolved) return resolved;
      }
    }
  }
  return null;
}

function resolveBareImport(vfs: Vfs, projectDir: string, specifier: string): string | null {
  const scoped = specifier.startsWith("@");
  const parts = specifier.split("/");
  const packageName = scoped ? parts.slice(0, 2).join("/") : (parts[0] as string);
  const subpath = specifier.slice(packageName.length).replace(/^\//, "");
  // Walk up from the project dir looking for node_modules.
  let current = projectDir;
  for (;;) {
    const packageDir = joinPath(current, "node_modules", packageName);
    if (vfs.getRecord(packageDir)?.type === "dir") {
      const packageJsonPath = joinPath(packageDir, "package.json");
      let manifest: {
        exports?: ExportsField | Record<string, ExportsField>;
        browser?: string | Record<string, string | false>;
        module?: string;
        main?: string;
      } = {};
      try {
        manifest = JSON.parse(vfs.readTextFile(packageJsonPath)) as typeof manifest;
      } catch {
        manifest = {};
      }
      if (subpath) {
        const exportsField = manifest.exports as Record<string, ExportsField> | undefined;
        const subKey = `./${subpath}`;
        if (exportsField && typeof exportsField === "object" && subKey in exportsField) {
          const target = resolveExportsTarget(exportsField[subKey] ?? null);
          if (target) return tryFile(vfs, joinPath(packageDir, target));
        }
        return tryFile(vfs, joinPath(packageDir, subpath));
      }
      if (manifest.exports) {
        const exportsField = manifest.exports;
        const rootTarget =
          typeof exportsField === "object" && exportsField !== null && "." in exportsField
            ? resolveExportsTarget((exportsField as Record<string, ExportsField>)["."] ?? null)
            : resolveExportsTarget(exportsField as ExportsField);
        if (rootTarget) {
          const resolved = tryFile(vfs, joinPath(packageDir, rootTarget));
          if (resolved) return resolved;
        }
      }
      const browserField = typeof manifest.browser === "string" ? manifest.browser : null;
      for (const candidate of [browserField, manifest.module, manifest.main, "index.js"]) {
        if (!candidate) continue;
        const resolved = tryFile(vfs, joinPath(packageDir, candidate));
        if (resolved) return resolved;
      }
      return null;
    }
    if (current === "/") return null;
    current = dirname(current);
  }
}

export function createVfsPlugin(input: {
  vfs: Vfs;
  projectDir: string;
  /** Resolve node builtins to runtime shims instead of failing (node command). */
  shimNodeBuiltins: boolean;
}): EsbuildTypes.Plugin {
  const { vfs, projectDir } = input;
  return {
    name: "cesium-vfs",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const specifier = args.path;
        const bare = specifier.replace(/^node:/, "");
        if (specifier.startsWith("node:") || NODE_BUILTINS.has(bare)) {
          if (input.shimNodeBuiltins) {
            return { path: bare, namespace: "cesium-node-shim" };
          }
          return {
            errors: [
              {
                text: `Node builtin "${specifier}" is not available when bundling for the browser preview.`,
              },
            ],
          };
        }
        if (specifier.startsWith("/")) {
          const resolved = tryFile(vfs, normalizePath(specifier));
          return resolved
            ? { path: resolved, namespace: "cesium-vfs" }
            : { errors: [{ text: `Cannot resolve ${specifier}` }] };
        }
        if (specifier.startsWith("./") || specifier.startsWith("../")) {
          const importerDir = args.importer ? dirname(args.importer) : projectDir;
          const resolved = tryFile(vfs, joinPath(importerDir, specifier));
          return resolved
            ? { path: resolved, namespace: "cesium-vfs" }
            : { errors: [{ text: `Cannot resolve ${specifier} from ${args.importer}` }] };
        }
        const resolved = resolveBareImport(vfs, projectDir, specifier);
        return resolved
          ? { path: resolved, namespace: "cesium-vfs" }
          : {
              errors: [
                {
                  text: `Cannot resolve package "${specifier}". Run \`npm install ${specifier}\` first.`,
                },
              ],
            };
      });
      build.onLoad({ filter: /.*/, namespace: "cesium-vfs" }, (args) => {
        try {
          return {
            contents: vfs.readFile(args.path).slice(),
            loader: loaderForPath(args.path),
            resolveDir: dirname(args.path),
          };
        } catch (error) {
          return {
            errors: [{ text: error instanceof Error ? error.message : String(error) }],
          };
        }
      });
      build.onLoad({ filter: /.*/, namespace: "cesium-node-shim" }, (args) => ({
        contents: `module.exports = globalThis.__cesiumNodeShims?.[${JSON.stringify(args.path)}] ?? {};`,
        loader: "js",
      }));
    },
  };
}

export type BundleResult = {
  outputs: Array<{ path: string; bytes: Uint8Array }>;
  errors: string[];
  warnings: string[];
};

export async function bundleWithVfs(input: {
  vfs: Vfs;
  projectDir: string;
  entryPoint: string;
  format?: EsbuildTypes.Format;
  minify?: boolean;
  shimNodeBuiltins?: boolean;
  globalName?: string;
}): Promise<BundleResult> {
  const esbuild = await getEsbuild();
  try {
    const result = await esbuild.build({
      entryPoints: [input.entryPoint],
      bundle: true,
      write: false,
      format: input.format ?? "iife",
      platform: "browser",
      target: "es2020",
      minify: input.minify ?? false,
      sourcemap: false,
      logLevel: "silent",
      define: { "process.env.NODE_ENV": '"development"' },
      ...(input.globalName ? { globalName: input.globalName } : {}),
      plugins: [
        createVfsPlugin({
          vfs: input.vfs,
          projectDir: input.projectDir,
          shimNodeBuiltins: input.shimNodeBuiltins ?? false,
        }),
      ],
    });
    return {
      outputs: (result.outputFiles ?? []).map((file) => ({
        path: file.path,
        bytes: file.contents,
      })),
      errors: [],
      warnings: result.warnings.map((warning) => warning.text),
    };
  } catch (error) {
    const buildError = error as { errors?: Array<{ text: string }> };
    return {
      outputs: [],
      errors: buildError.errors?.map((entry) => entry.text) ?? [
        error instanceof Error ? error.message : String(error),
      ],
      warnings: [],
    };
  }
}

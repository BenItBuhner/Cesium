/**
 * Built-in toolchain pack definitions: Python (Pyodide) and Ruby
 * (ruby.wasm) load fully client-side from CDNs; compiled-language packs
 * (Go/Rust/C via WASI toolchains) are registered as roadmap entries and the
 * Linux VM tier is the current fallback for them.
 */
import { basename, dirname, joinPath, toRelativePath } from "../paths";
import type { Vfs } from "../vfs";
import { resolvePath, type ShellContext } from "../shell/builtins";
import type { PackManager, ToolchainPack } from "./registry";

const PYODIDE_VERSION = "0.28.3";
const RUBY_WASM_URL =
  "https://cdn.jsdelivr.net/npm/@ruby/3.4-wasm-wasi@2.7.2/dist/browser/+esm";

type PyodideLike = {
  runPythonAsync(code: string): Promise<unknown>;
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string, options?: { encoding?: "binary" }): Uint8Array;
    mkdirTree(path: string): void;
    readdir(path: string): string[];
    stat(path: string): { mode: number };
    isDir(mode: number): boolean;
  };
  setStdout(options: { batched: (text: string) => void }): void;
  setStderr(options: { batched: (text: string) => void }): void;
};

async function loadPyodideRuntime(): Promise<PyodideLike> {
  const pyodideModule = (await import(
    /* webpackIgnore: true */
    `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/pyodide.mjs`
  )) as { loadPyodide(options: { indexURL: string }): Promise<PyodideLike> };
  return pyodideModule.loadPyodide({
    indexURL: `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`,
  });
}

const MAX_SYNC_BYTES = 20_000_000;

/** Copy the shell cwd into the Emscripten FS, run, then copy results back. */
function syncIntoEmscripten(vfs: Vfs, pyodide: PyodideLike, cwd: string, guestRoot: string): void {
  let copied = 0;
  const walk = (dir: string): void => {
    for (const child of vfs.listChildren(dir)) {
      const relative = toRelativePath(cwd, child.path);
      if (!relative || relative.startsWith("node_modules") || relative.startsWith(".git")) {
        continue;
      }
      const guestPath = `${guestRoot}/${relative}`;
      if (child.type === "dir") {
        pyodide.FS.mkdirTree(guestPath);
        walk(child.path);
      } else if (child.type === "file") {
        const bytes = child.data ?? new Uint8Array(0);
        copied += bytes.byteLength;
        if (copied > MAX_SYNC_BYTES) return;
        pyodide.FS.mkdirTree(guestPath.slice(0, guestPath.lastIndexOf("/")) || "/");
        pyodide.FS.writeFile(guestPath, bytes.slice());
      }
    }
  };
  pyodide.FS.mkdirTree(guestRoot);
  walk(cwd);
}

function syncBackFromEmscripten(
  vfs: Vfs,
  pyodide: PyodideLike,
  cwd: string,
  guestRoot: string
): void {
  const walk = (guestDir: string): void => {
    for (const name of pyodide.FS.readdir(guestDir)) {
      if (name === "." || name === "..") continue;
      const guestPath = `${guestDir}/${name}`;
      const stat = pyodide.FS.stat(guestPath);
      const relative = guestPath.slice(guestRoot.length + 1);
      const hostPath = joinPath(cwd, relative);
      if (pyodide.FS.isDir(stat.mode)) {
        if (!vfs.exists(hostPath)) vfs.mkdir(hostPath, { recursive: true });
        walk(guestPath);
      } else {
        const bytes = pyodide.FS.readFile(guestPath, { encoding: "binary" });
        const existing = vfs.getRecord(hostPath);
        const changed =
          !existing ||
          existing.type !== "file" ||
          (existing.data?.byteLength ?? 0) !== bytes.byteLength ||
          !existing.data?.every((byte, index) => byte === bytes[index]);
        if (changed) {
          const parent = dirname(hostPath);
          if (!vfs.exists(parent)) vfs.mkdir(parent, { recursive: true });
          vfs.writeFile(hostPath, bytes.slice());
        }
      }
    }
  };
  walk(guestRoot);
}

function createPythonPack(): ToolchainPack {
  let pyodide: PyodideLike | null = null;
  return {
    id: "python",
    label: "Python (Pyodide)",
    description: "CPython 3 + micropip; pure-Python packages installable at runtime.",
    approxSize: "12 MB",
    commands: ["python", "python3", "pip"],
    status: "available",
    async load(shell, vfs) {
      pyodide = await loadPyodideRuntime();
      const handler = async (argv: string[], ctx: ShellContext): Promise<number> => {
        if (!pyodide) {
          ctx.io.writeErr("python: runtime not loaded\n");
          return 1;
        }
        let code: string | null = null;
        let scriptPath: string | null = null;
        const scriptArgs: string[] = [];
        for (let i = 0; i < argv.length; i += 1) {
          const arg = argv[i] as string;
          if (arg === "-c") {
            code = argv[++i] ?? "";
          } else if (arg === "-V" || arg === "--version") {
            ctx.io.write("Python 3 (Pyodide, browser)\n");
            return 0;
          } else if (!scriptPath && !arg.startsWith("-")) {
            scriptPath = arg;
          } else {
            scriptArgs.push(arg);
          }
        }
        if (code === null && !scriptPath) {
          ctx.io.writeErr("python: interactive mode is unsupported; pass a script or -c code\n");
          return 2;
        }
        const guestRoot = "/home/pyodide/cwd";
        syncIntoEmscripten(vfs, pyodide, ctx.cwd.value, guestRoot);
        pyodide.setStdout({ batched: (text) => ctx.io.write(`${text}\n`) });
        pyodide.setStderr({ batched: (text) => ctx.io.writeErr(`${text}\n`) });
        const source =
          code ??
          new TextDecoder().decode(vfs.readFile(resolvePath(ctx, scriptPath as string)));
        try {
          await pyodide.runPythonAsync(
            [
              "import os, sys",
              `os.chdir(${JSON.stringify(guestRoot)})`,
              `sys.argv = ${JSON.stringify([scriptPath ?? "-c", ...scriptArgs])}`,
              source,
            ].join("\n")
          );
          syncBackFromEmscripten(vfs, pyodide, ctx.cwd.value, guestRoot);
          return 0;
        } catch (error) {
          syncBackFromEmscripten(vfs, pyodide, ctx.cwd.value, guestRoot);
          ctx.io.writeErr(`${error instanceof Error ? error.message : String(error)}\n`);
          return 1;
        }
      };
      shell.registerCommand("python", handler);
      shell.registerCommand("python3", handler);
      shell.registerCommand("pip", async (argv, ctx) => {
        if (!pyodide) {
          ctx.io.writeErr("pip: runtime not loaded\n");
          return 1;
        }
        if (argv[0] !== "install" || argv.length < 2) {
          ctx.io.writeErr("pip: only `pip install <package…>` is supported (micropip)\n");
          return 1;
        }
        const packages = argv.slice(1).filter((arg) => !arg.startsWith("-"));
        pyodide.setStdout({ batched: (text) => ctx.io.write(`${text}\n`) });
        pyodide.setStderr({ batched: (text) => ctx.io.writeErr(`${text}\n`) });
        try {
          await pyodide.runPythonAsync(
            [
              "import micropip",
              `await micropip.install(${JSON.stringify(packages)})`,
              `print("installed:", ${JSON.stringify(packages.join(", "))})`,
            ].join("\n")
          );
          return 0;
        } catch (error) {
          ctx.io.writeErr(`pip: ${error instanceof Error ? error.message : String(error)}\n`);
          return 1;
        }
      });
    },
  };
}

type RubyVmLike = { evalAsync(code: string): Promise<{ toString(): string }> };

function createRubyPack(): ToolchainPack {
  let vm: RubyVmLike | null = null;
  return {
    id: "ruby",
    label: "Ruby (ruby.wasm)",
    description: "Official CRuby compiled to WASI; scripts and -e one-liners.",
    approxSize: "25 MB",
    commands: ["ruby"],
    status: "available",
    async load(shell, vfs) {
      const rubyModule = (await import(/* webpackIgnore: true */ RUBY_WASM_URL)) as {
        DefaultRubyVM(wasmModule: WebAssembly.Module): Promise<{ vm: RubyVmLike }>;
      };
      const wasmUrl = RUBY_WASM_URL.replace("/browser/+esm", "/ruby+stdlib.wasm");
      const wasmResponse = await fetch(wasmUrl);
      if (!wasmResponse.ok) {
        throw new Error(`ruby.wasm download failed (${wasmResponse.status})`);
      }
      const wasmModule = await WebAssembly.compileStreaming(wasmResponse);
      vm = (await rubyModule.DefaultRubyVM(wasmModule)).vm;
      shell.registerCommand("ruby", async (argv: string[], ctx: ShellContext) => {
        if (!vm) {
          ctx.io.writeErr("ruby: runtime not loaded\n");
          return 1;
        }
        let source: string | null = null;
        for (let i = 0; i < argv.length; i += 1) {
          const arg = argv[i] as string;
          if (arg === "-e") {
            source = argv[++i] ?? "";
          } else if (arg === "-v" || arg === "--version") {
            ctx.io.write("ruby (ruby.wasm, browser)\n");
            return 0;
          } else if (!arg.startsWith("-") && source === null) {
            const path = resolvePath(ctx, arg);
            if (!vfs.exists(path)) {
              ctx.io.writeErr(`ruby: ${arg}: no such file\n`);
              return 1;
            }
            source = new TextDecoder().decode(vfs.readFile(path));
          }
        }
        if (source === null) {
          ctx.io.writeErr("ruby: pass a script file or -e code\n");
          return 2;
        }
        try {
          const wrapped = [
            "require 'stringio'",
            "__cesium_out = StringIO.new",
            "$stdout = __cesium_out",
            "begin",
            source,
            "ensure",
            "  $stdout = STDOUT",
            "end",
            "__cesium_out.string",
          ].join("\n");
          const result = await vm.evalAsync(wrapped);
          const output = result.toString();
          if (output) ctx.io.write(output.endsWith("\n") ? output : `${output}\n`);
          return 0;
        } catch (error) {
          ctx.io.writeErr(`ruby: ${error instanceof Error ? error.message : String(error)}\n`);
          return 1;
        }
      });
      void basename;
    },
  };
}

export function registerBuiltinPacks(manager: PackManager): void {
  manager.register(createPythonPack());
  manager.register(createRubyPack());
  manager.register({
    id: "go",
    label: "Go (WASI toolchain)",
    description: "Compile/run Go via a WASI-built toolchain. Roadmap: wasm-oj/forge toolchain integration.",
    approxSize: "100+ MB",
    commands: ["go"],
    status: "planned",
  });
  manager.register({
    id: "rust",
    label: "Rust (WASI toolchain)",
    description: "rustc + wasm-ld compiled to WASI. Roadmap: wasm-oj/forge toolchain integration.",
    approxSize: "200+ MB",
    commands: ["rustc", "cargo"],
    status: "planned",
  });
  manager.register({
    id: "clang",
    label: "C/C++ (clang WASI)",
    description: "clang/lld in the browser. Roadmap: wasm-oj/forge or llvm-wasi integration.",
    approxSize: "100+ MB",
    commands: ["cc", "clang"],
    status: "planned",
  });
}

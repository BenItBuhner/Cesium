/**
 * `node` for the browser machine: bundle the entry with esbuild-wasm
 * (node builtins shimmed to VFS-backed implementations), then execute the
 * IIFE in-page with console/process wired to the shell's stdio.
 */
import { basename, dirname, extname, joinPath, normalizePath } from "../paths";
import type { Vfs } from "../vfs";
import type { ShellRuntime } from "../shell/runtime";
import { resolvePath, type ShellContext } from "../shell/builtins";
import { bundleWithVfs } from "../build/esbuild-service";

function pathShim(): Record<string, unknown> {
  return {
    join: (...parts: string[]) => joinPath(...parts),
    resolve: (...parts: string[]) => {
      let result = "/";
      for (const part of parts) {
        result = part.startsWith("/") ? normalizePath(part) : joinPath(result, part);
      }
      return result;
    },
    dirname,
    basename,
    extname,
    normalize: normalizePath,
    sep: "/",
    posix: { join: joinPath, dirname, basename, extname, sep: "/" },
    isAbsolute: (path: string) => path.startsWith("/"),
    relative: (from: string, to: string) => {
      const fromParts = normalizePath(from).split("/").filter(Boolean);
      const toParts = normalizePath(to).split("/").filter(Boolean);
      let common = 0;
      while (
        common < fromParts.length &&
        common < toParts.length &&
        fromParts[common] === toParts[common]
      ) {
        common += 1;
      }
      return [
        ...fromParts.slice(common).map(() => ".."),
        ...toParts.slice(common),
      ].join("/");
    },
  };
}

function fsShim(vfs: Vfs, cwd: string): Record<string, unknown> {
  const abs = (path: string): string =>
    path.startsWith("/") ? normalizePath(path) : joinPath(cwd, path);
  const decoder = new TextDecoder();
  const readFileSync = (path: string, options?: { encoding?: string } | string): unknown => {
    const bytes = vfs.readFile(abs(path));
    const encoding = typeof options === "string" ? options : options?.encoding;
    return encoding ? decoder.decode(bytes) : bytes.slice();
  };
  const writeFileSync = (path: string, data: unknown): void => {
    const target = abs(path);
    const parent = dirname(target);
    if (!vfs.exists(parent)) vfs.mkdir(parent, { recursive: true });
    vfs.writeFile(
      target,
      typeof data === "string"
        ? data
        : data instanceof Uint8Array
          ? data
          : String(data)
    );
  };
  const sync = {
    readFileSync,
    writeFileSync,
    existsSync: (path: string) => vfs.exists(abs(path)),
    mkdirSync: (path: string, options?: { recursive?: boolean }) =>
      vfs.mkdir(abs(path), options),
    readdirSync: (path: string) => vfs.readDir(abs(path)),
    rmSync: (path: string) => vfs.rm(abs(path)),
    unlinkSync: (path: string) => vfs.unlink(abs(path)),
    statSync: (path: string) => vfs.stat(abs(path)),
    renameSync: (from: string, to: string) => vfs.rename(abs(from), abs(to)),
    appendFileSync: (path: string, data: unknown) => {
      const target = abs(path);
      const existing = vfs.exists(target) ? decoder.decode(vfs.readFile(target)) : "";
      writeFileSync(path, existing + String(data));
    },
  };
  return {
    ...sync,
    promises: {
      readFile: async (path: string, options?: { encoding?: string } | string) =>
        readFileSync(path, options),
      writeFile: async (path: string, data: unknown) => writeFileSync(path, data),
      mkdir: async (path: string, options?: { recursive?: boolean }) =>
        sync.mkdirSync(path, options),
      readdir: async (path: string) => sync.readdirSync(path),
      rm: async (path: string) => sync.rmSync(path),
      stat: async (path: string) => sync.statSync(path),
      rename: async (from: string, to: string) => sync.renameSync(from, to),
      access: async (path: string) => {
        if (!vfs.exists(abs(path))) throw new Error(`ENOENT: ${path}`);
      },
    },
  };
}

export function registerNodeCommand(shell: ShellRuntime, vfs: Vfs): void {
  const handler = async (argv: string[], ctx: ShellContext): Promise<number> => {
    let entryArg: string | null = null;
    let evalCode: string | null = null;
    const scriptArgs: string[] = [];
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i] as string;
      if (arg === "-e" || arg === "--eval") {
        evalCode = argv[++i] ?? "";
      } else if (arg === "-v" || arg === "--version") {
        ctx.io.write("v20.0.0-cesium-browser\n");
        return 0;
      } else if (!entryArg && !arg.startsWith("-")) {
        entryArg = arg;
      } else if (entryArg) {
        scriptArgs.push(arg);
      }
    }
    let entryPoint: string;
    if (evalCode !== null) {
      entryPoint = joinPath(ctx.cwd.value, `.cesium-eval-${Date.now().toString(36)}.js`);
      vfs.writeFile(entryPoint, evalCode);
    } else if (entryArg) {
      entryPoint = resolvePath(ctx, entryArg);
      if (!vfs.exists(entryPoint)) {
        // node resolution: allow omitting the extension.
        const withExtension = [".js", ".mjs", ".cjs", ".ts"].map((ext) => `${entryPoint}${ext}`).find((candidate) => vfs.exists(candidate));
        if (!withExtension) {
          ctx.io.writeErr(`node: cannot find module '${entryArg}'\n`);
          return 1;
        }
        entryPoint = withExtension;
      }
    } else {
      ctx.io.writeErr("node: interactive REPL is not supported; pass a script or -e code\n");
      return 2;
    }

    try {
      const bundled = await bundleWithVfs({
        vfs,
        projectDir: ctx.cwd.value,
        entryPoint,
        format: "iife",
        shimNodeBuiltins: true,
      });
      if (bundled.errors.length > 0) {
        for (const error of bundled.errors) {
          ctx.io.writeErr(`node: ${error}\n`);
        }
        return 1;
      }
      const code = new TextDecoder().decode(bundled.outputs[0]?.bytes ?? new Uint8Array(0));

      const globalTarget = globalThis as Record<string, unknown>;
      const previousShims = globalTarget.__cesiumNodeShims;
      const previousProcess = globalTarget.process;
      const previousConsole = globalTarget.console;
      const format = (args: unknown[]): string =>
        args
          .map((value) =>
            typeof value === "string"
              ? value
              : value instanceof Error
                ? (value.stack ?? value.message)
                : JSON.stringify(value, null, 0)
          )
          .join(" ");
      let exitCode = 0;
      const processShim = {
        env: Object.fromEntries(ctx.env),
        argv: ["node", entryPoint, ...scriptArgs],
        cwd: () => ctx.cwd.value,
        platform: "browser",
        exit: (code?: number) => {
          exitCode = code ?? 0;
          throw new Error(`__cesium_process_exit_${exitCode}__`);
        },
        nextTick: (fn: () => void) => queueMicrotask(fn),
        stdout: { write: (text: string) => ctx.io.write(text) },
        stderr: { write: (text: string) => ctx.io.writeErr(text) },
      };
      globalTarget.__cesiumNodeShims = {
        fs: fsShim(vfs, ctx.cwd.value),
        path: pathShim(),
        os: { platform: () => "browser", homedir: () => "/workspaces", EOL: "\n", tmpdir: () => "/tmp" },
        url: { fileURLToPath: (url: string) => url.replace(/^file:\/\//, "") },
        util: {
          format,
          promisify: (fn: unknown) => fn,
          inspect: (value: unknown) => JSON.stringify(value, null, 2),
        },
        events: {},
        process: processShim,
        buffer: {},
      };
      const consoleShim = {
        ...console,
        log: (...args: unknown[]) => ctx.io.write(`${format(args)}\n`),
        info: (...args: unknown[]) => ctx.io.write(`${format(args)}\n`),
        warn: (...args: unknown[]) => ctx.io.writeErr(`${format(args)}\n`),
        error: (...args: unknown[]) => ctx.io.writeErr(`${format(args)}\n`),
        debug: (...args: unknown[]) => ctx.io.write(`${format(args)}\n`),
      };
      try {
        const run = new Function("process", "console", `${code}\n`);
        const result: unknown = run(processShim, consoleShim);
        if (result && typeof (result as Promise<unknown>).then === "function") {
          await result;
        }
        // Give queued microtasks/immediate timers a brief window to settle.
        await new Promise((resolve) => setTimeout(resolve, 30));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const exitMatch = message.match(/__cesium_process_exit_(\d+)__/);
        if (!exitMatch) {
          ctx.io.writeErr(
            `node: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
          );
          return 1;
        }
        exitCode = Number(exitMatch[1]);
      } finally {
        globalTarget.__cesiumNodeShims = previousShims;
        globalTarget.process = previousProcess;
        globalTarget.console = previousConsole;
        if (evalCode !== null && vfs.exists(entryPoint)) {
          vfs.unlink(entryPoint);
        }
      }
      return exitCode;
    } catch (error) {
      ctx.io.writeErr(`node: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  };
  shell.registerCommand("node", handler);
  shell.registerCommand("tsx", handler);
}

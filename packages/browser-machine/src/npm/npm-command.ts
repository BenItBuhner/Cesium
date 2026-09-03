/**
 * `npm` for the browser machine: install (registry fetch into the VFS),
 * run (package.json scripts through the shell), init.
 */
import { joinPath } from "../paths";
import type { Vfs } from "../vfs";
import type { ShellRuntime } from "../shell/runtime";
import { resolvePath, type ShellContext } from "../shell/builtins";
import { NpmClient } from "./registry";

function parsePackageArg(arg: string): { name: string; range: string } {
  const at = arg.lastIndexOf("@");
  if (at > 0) {
    return { name: arg.slice(0, at), range: arg.slice(at + 1) || "latest" };
  }
  return { name: arg, range: "latest" };
}

export function registerNpmCommands(shell: ShellRuntime, vfs: Vfs): void {
  const npm = new NpmClient(vfs);

  const handler = async (argv: string[], ctx: ShellContext): Promise<number> => {
    const sub = argv[0] ?? "help";
    const projectDir = ctx.cwd.value;
    const packageJsonPath = joinPath(projectDir, "package.json");

    if (sub === "install" || sub === "i" || sub === "add" || sub === "ci") {
      const requested = argv
        .slice(1)
        .filter((arg) => !arg.startsWith("-"))
        .map(parsePackageArg);
      let packages = requested;
      if (packages.length === 0) {
        if (!vfs.exists(packageJsonPath)) {
          ctx.io.writeErr("npm install: no package.json in the current directory\n");
          return 1;
        }
        try {
          const manifest = JSON.parse(vfs.readTextFile(packageJsonPath)) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
          };
          packages = [
            ...Object.entries(manifest.dependencies ?? {}),
            ...Object.entries(manifest.devDependencies ?? {}),
          ].map(([name, range]) => ({ name, range }));
        } catch (error) {
          ctx.io.writeErr(
            `npm install: invalid package.json (${error instanceof Error ? error.message : error})\n`
          );
          return 1;
        }
      }
      if (packages.length === 0) {
        ctx.io.write("npm install: nothing to install\n");
        return 0;
      }
      try {
        const result = await npm.install({
          projectDir,
          packages,
          onProgress: (message) => ctx.io.write(`npm: ${message}\n`),
        });
        // Record newly requested packages in package.json dependencies.
        if (requested.length > 0 && vfs.exists(packageJsonPath)) {
          try {
            const manifest = JSON.parse(vfs.readTextFile(packageJsonPath)) as {
              dependencies?: Record<string, string>;
            };
            manifest.dependencies = manifest.dependencies ?? {};
            for (const installed of result.installed) {
              const at = installed.lastIndexOf("@");
              const name = installed.slice(0, at);
              const version = installed.slice(at + 1);
              if (requested.some((entry) => entry.name === name)) {
                manifest.dependencies[name] = `^${version}`;
              }
            }
            vfs.writeFile(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
          } catch {
            // Leave package.json untouched when parsing fails.
          }
        }
        ctx.io.write(`added ${result.installed.length} package${result.installed.length === 1 ? "" : "s"}\n`);
        return 0;
      } catch (error) {
        ctx.io.writeErr(
          `npm install failed: ${error instanceof Error ? error.message : String(error)}\n`
        );
        return 1;
      }
    }

    if (sub === "run" || sub === "run-script") {
      const scriptName = argv[1];
      if (!scriptName) {
        ctx.io.writeErr("npm run: missing script name\n");
        return 1;
      }
      if (!vfs.exists(packageJsonPath)) {
        ctx.io.writeErr("npm run: no package.json in the current directory\n");
        return 1;
      }
      let script: string | undefined;
      try {
        const manifest = JSON.parse(vfs.readTextFile(packageJsonPath)) as {
          scripts?: Record<string, string>;
        };
        script = manifest.scripts?.[scriptName];
      } catch {
        script = undefined;
      }
      if (!script) {
        ctx.io.writeErr(`npm run: script "${scriptName}" not found\n`);
        return 1;
      }
      ctx.io.write(`> ${script}\n`);
      return ctx.runScript(script, ctx.io);
    }

    if (sub === "init") {
      const name = ctx.cwd.value.split("/").pop() || "project";
      if (!vfs.exists(packageJsonPath)) {
        vfs.writeFile(
          packageJsonPath,
          `${JSON.stringify(
            {
              name,
              version: "0.1.0",
              private: true,
              scripts: { start: "node index.js" },
              dependencies: {},
            },
            null,
            2
          )}\n`
        );
      }
      ctx.io.write(`Wrote ${packageJsonPath}\n`);
      return 0;
    }

    if (sub === "ls" || sub === "list") {
      const nodeModules = joinPath(projectDir, "node_modules");
      if (!vfs.exists(nodeModules)) {
        ctx.io.write("(empty)\n");
        return 0;
      }
      for (const entry of vfs.readDir(nodeModules)) {
        if (entry.startsWith("@")) {
          for (const scopedEntry of vfs.readDir(joinPath(nodeModules, entry))) {
            ctx.io.write(`${entry}/${scopedEntry}\n`);
          }
        } else {
          ctx.io.write(`${entry}\n`);
        }
      }
      return 0;
    }

    if (sub === "-v" || sub === "--version") {
      ctx.io.write("10.0.0-cesium-browser\n");
      return 0;
    }

    ctx.io.writeErr(
      `npm: unsupported subcommand "${sub}" (supported: install, run, init, ls)\n`
    );
    return 1;
  };

  shell.registerCommand("npm", handler);
  shell.registerCommand("pnpm", handler);
  shell.registerCommand("npx", async (argv, ctx) => {
    ctx.io.writeErr(
      `npx is not supported on the browser machine${argv[0] ? ` (tried: ${argv[0]})` : ""}. Install the package with npm install and run it via node or an npm script instead.\n`
    );
    return 1;
  });

  void resolvePath;
}

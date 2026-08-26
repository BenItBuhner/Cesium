import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { bundledInstallerPath, resolveExistingSource } from "./paths.mjs";
import { renderHelp } from "./help.mjs";

export const INSTALLER_URL =
  "https://raw.githubusercontent.com/BenItBuhner/Cesium/main/scripts/install-cesium-server.sh";

/**
 * @param {string[]} args
 * @param {{ version: string, fail: (message: string) => never }} ctx
 */
export function parseInstallArgs(args, ctx) {
  const env = { ...process.env };
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === "--web-url") {
      const value = args[i + 1];
      if (!value) {
        ctx.fail("--web-url requires a value, e.g. --web-url https://cesium.example.com");
      }
      env.CESIUM_WEB_URL = value;
      i += 1;
    } else if (flag === "--from-source") {
      const value = args[i + 1];
      if (!value) {
        ctx.fail("--from-source requires a directory, e.g. --from-source .");
      }
      const resolved = resolveExistingSource(value);
      if (!existsSync(resolved)) {
        ctx.fail(`--from-source directory does not exist: ${resolved}`);
      }
      env.CESIUM_EXISTING_SOURCE = resolved;
      env.CESIUM_SKIP_SOURCE_UPDATE = "1";
      i += 1;
    } else if (flag === "--no-start") {
      env.CESIUM_SKIP_AUTOSTART = "1";
    } else if (flag === "--skip-tunnel") {
      env.CESIUM_SKIP_TUNNEL = "1";
    } else {
      ctx.fail(`Unknown install option: ${flag}\n\n${renderHelp(ctx.version)}`);
    }
  }
  return env;
}

async function loadInstallerScript(fromSource) {
  if (fromSource) {
    const local = path.join(fromSource, "scripts", "install-cesium-server.sh");
    if (existsSync(local)) {
      return readFileSync(local, "utf8");
    }
  }
  const bundled = bundledInstallerPath();
  if (bundled && existsSync(bundled)) {
    return readFileSync(bundled, "utf8");
  }
  const response = await fetch(INSTALLER_URL);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return await response.text();
}

/**
 * @param {string[]} args
 * @param {{ version: string, fail: (message: string) => never }} ctx
 */
export async function runInstall(args, ctx) {
  const env = parseInstallArgs(args, ctx);
  let script;
  try {
    script = await loadInstallerScript(env.CESIUM_EXISTING_SOURCE);
  } catch (error) {
    ctx.fail(
      `Could not load the Cesium installer (${error?.message ?? error}).\n` +
        `Fetch it manually from ${INSTALLER_URL}`
    );
  }

  const scriptPath = path.join(mkdtempSync(path.join(tmpdir(), "cesium-install-")), "install.sh");
  writeFileSync(scriptPath, script, { mode: 0o700 });
  const result = spawnSync("bash", [scriptPath], { stdio: "inherit", env });
  process.exit(result.status ?? 1);
}

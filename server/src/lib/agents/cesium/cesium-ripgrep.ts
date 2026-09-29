import { spawn } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const RG_BINARY = process.platform === "win32" ? "rg.exe" : "rg";

let detection: Promise<string | null> | null = null;
let override: string | null | undefined;

/** Test hook: pin the ripgrep binary (`null` forces the JS fallback); `undefined` restores detection. */
export function setRipgrepBinaryOverride(binary: string | null | undefined): void {
  override = binary;
  detection = null;
}

function pathCandidates(): string[] {
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, RG_BINARY));
}

/** `@cursor/sdk` (a server dependency) ships ripgrep in its per-platform package. */
function vendoredCandidates(): string[] {
  try {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve(`@cursor/sdk-${process.platform}-${process.arch}/package.json`);
    return [path.join(path.dirname(manifest), "bin", RG_BINARY)];
  } catch {
    return [];
  }
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await fs.access(file, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

function reportsRipgrepVersion(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(binary, ["--version"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 5_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && stdout.startsWith("ripgrep"));
    });
  });
}

async function detectRipgrep(): Promise<string | null> {
  for (const candidate of [...pathCandidates(), ...vendoredCandidates()]) {
    if ((await isExecutable(candidate)) && (await reportsRipgrepVersion(candidate))) {
      return candidate;
    }
  }
  return null;
}

/** Absolute path of a working ripgrep binary, detected once per process; null when none is available. */
export function resolveRipgrepBinary(): Promise<string | null> {
  if (override !== undefined) {
    return Promise.resolve(override);
  }
  detection ??= detectRipgrep();
  return detection;
}

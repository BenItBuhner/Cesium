import { Buffer } from "node:buffer";

/**
 * Linux `execve` enforces a combined limit on argument strings + environment strings
 * (typically ~2 MiB). Node surfaces overflows as `spawn E2BIG`.
 *
 * Passing the full parent `process.env` into every child can exceed that limit in
 * container/CI setups with huge config-in-env. This helper trims non-essential
 * variables (largest values first) while preserving credentials and path plumbing.
 */
const DEFAULT_MAX_ENV_BYTES = 1_600_000;

function envApproxBytes(env: Record<string, string | undefined>): number {
  let n = 0;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) {
      continue;
    }
    n += k.length + Buffer.byteLength(String(v), "utf8") + 2;
  }
  return n;
}

function mustRetainEnvKey(key: string): boolean {
  if (
    key === "PATH" ||
    key === "PATHEXT" ||
    key === "HOME" ||
    key === "USER" ||
    key === "LOGNAME" ||
    key === "SHELL" ||
    key === "LANG" ||
    key === "LC_ALL" ||
    key === "LC_CTYPE" ||
    key === "TMPDIR" ||
    key === "TEMP" ||
    key === "TMP" ||
    key === "TZ" ||
    key === "TERM" ||
    key === "CURSOR_INVOKED_AS" ||
    key === "ComSpec" ||
    key === "SystemRoot" ||
    key === "WINDIR" ||
    key === "APPDATA" ||
    key === "LOCALAPPDATA" ||
    key === "USERPROFILE"
  ) {
    return true;
  }
  const upper = key.toUpperCase();
  return (
    upper.startsWith("OPENCURSOR_") ||
    upper.startsWith("OPENAI_") ||
    upper.startsWith("ANTHROPIC_") ||
    upper.startsWith("CLAUDE_") ||
    upper.startsWith("GEMINI_") ||
    upper.startsWith("GOOGLE_") ||
    upper.startsWith("AWS_") ||
    upper.startsWith("AZURE_") ||
    upper.startsWith("NODE_") ||
    upper.startsWith("NPM_") ||
    upper.startsWith("PNPM_") ||
    upper.startsWith("SSL_") ||
    upper.startsWith("XDG_") ||
    upper.startsWith("SSH_") ||
    upper.startsWith("GIT_") ||
    upper.startsWith("CURSOR_")
  );
}

export function spawnSafeEnv(
  overrides?: NodeJS.ProcessEnv,
  maxBytes: number = DEFAULT_MAX_ENV_BYTES
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  if (envApproxBytes(merged) <= maxBytes) {
    return merged;
  }

  const trimmed: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined) {
      continue;
    }
    if (mustRetainEnvKey(k)) {
      trimmed[k] = v;
    }
  }

  const droppable = Object.entries(merged)
    .filter(([k, v]) => v !== undefined && trimmed[k] === undefined)
    .sort(
      ([, a], [, b]) =>
        Buffer.byteLength(String(b), "utf8") - Buffer.byteLength(String(a), "utf8")
    );

  let size = envApproxBytes(trimmed);
  for (const [k, v] of droppable) {
    const add = k.length + Buffer.byteLength(String(v), "utf8") + 2;
    if (size + add > maxBytes) {
      continue;
    }
    trimmed[k] = v as string;
    size += add;
  }

  if (envApproxBytes(trimmed) > maxBytes) {
    for (const k of Object.keys(trimmed)) {
      if (mustRetainEnvKey(k)) {
        continue;
      }
      delete trimmed[k];
      if (envApproxBytes(trimmed) <= maxBytes) {
        break;
      }
    }
  }

  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  let pathValue = trimmed[pathKey] ?? trimmed.PATH;
  while (pathValue && envApproxBytes(trimmed) > maxBytes) {
    const sep = process.platform === "win32" ? ";" : ":";
    const parts = pathValue.split(sep).filter(Boolean);
    if (parts.length <= 1) {
      break;
    }
    parts.pop();
    pathValue = parts.join(sep);
    if (trimmed[pathKey] !== undefined) {
      trimmed[pathKey] = pathValue;
    } else {
      trimmed.PATH = pathValue;
    }
  }

  return trimmed as NodeJS.ProcessEnv;
}

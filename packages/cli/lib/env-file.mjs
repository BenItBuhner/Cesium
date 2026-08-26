/**
 * Parse the bash-style KEY=value file the installer writes with `printf %q`.
 * Secrets are returned to callers; never print password-like values.
 */

function unquoteBashValue(raw) {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/'\\''/g, "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}

export function parseEnvFile(contents) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    env[key] = unquoteBashValue(trimmed.slice(eq + 1));
  }
  return env;
}

export function hasSecret(value) {
  return Boolean(value && value.trim());
}

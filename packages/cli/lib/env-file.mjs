/**
 * Tiny KEY=value env file helpers shared by the Windows engine manager.
 * Values are stored unquoted; newlines and leading/trailing whitespace are rejected.
 */

export function parseEnvFile(text) {
  const values = {};
  if (typeof text !== "string" || text.length === 0) {
    return values;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1);
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function serializeEnvFile(values) {
  const lines = [];
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid env key: ${key}`);
    }
    const stringValue = value == null ? "" : String(value);
    if (/[\r\n]/.test(stringValue)) {
      throw new Error(`Env value for ${key} cannot contain newlines`);
    }
    lines.push(`${key}=${stringValue}`);
  }
  return `${lines.join("\n")}\n`;
}

export function envValue(values, name, fallback = "") {
  const value = values[name];
  if (value == null || String(value).trim() === "") {
    return fallback;
  }
  return String(value);
}

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./persistence.js";

let cachedInstanceId: string | null = null;

function persistInstanceId(id: string): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(path.join(DATA_DIR, "engine-instance-id"), `${id}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // Best-effort: an in-memory id still proves the URL during this process.
  }
}

function readPersistedInstanceId(): string | null {
  try {
    const file = path.join(DATA_DIR, "engine-instance-id");
    if (!existsSync(file)) {
      return null;
    }
    const value = readFileSync(file, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

/** Stable id used to prove a public URL actually hits this engine. */
export function getEngineInstanceId(): string {
  const fromEnv = process.env.CESIUM_INSTANCE_ID?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  if (cachedInstanceId) {
    return cachedInstanceId;
  }
  const persisted = readPersistedInstanceId();
  if (persisted) {
    cachedInstanceId = persisted;
    return persisted;
  }
  cachedInstanceId = `cesium_${randomBytes(16).toString("hex")}`;
  persistInstanceId(cachedInstanceId);
  return cachedInstanceId;
}

export function resetEngineInstanceIdForTests(): void {
  cachedInstanceId = null;
}

import { promises as fs } from "node:fs";
import { DATA_DIR } from "../lib/persistence.js";
import type { StorageDriver, StorageDriverKind } from "./driver.js";

const VALID_KINDS: StorageDriverKind[] = ["legacy-json", "pg"];

let activeDriver: StorageDriver | null = null;
let initPromise: Promise<StorageDriver> | null = null;

/**
 * Resolves the default driver kind.
 *
 * Precedence:
 *   1. `OPENCURSOR_STORAGE_DRIVER` wins when explicitly set (lets legacy
 *      deployments opt in by force with "legacy-json").
 *   2. If `DATABASE_URL` is configured, default to "pg".
 *   3. Otherwise fall back to "legacy-json" so a fresh clone without any
 *      external services still runs out of the box.
 */
export function resolveConfiguredDriverKind(): StorageDriverKind {
  const raw = process.env.OPENCURSOR_STORAGE_DRIVER?.trim().toLowerCase() ?? "";
  if (raw.length > 0) {
    if ((VALID_KINDS as string[]).includes(raw)) {
      return raw as StorageDriverKind;
    }
    console.warn(
      `[storage] Unknown OPENCURSOR_STORAGE_DRIVER="${raw}", falling back to legacy-json.`
    );
    return "legacy-json";
  }
  const dbUrl = process.env.DATABASE_URL?.trim();
  if (dbUrl && dbUrl.length > 0) {
    return "pg";
  }
  return "legacy-json";
}

/**
 * Resolves the active storage driver, initializing it on first call. Safe to
 * call repeatedly; subsequent callers receive the same instance.
 *
 * Dynamic-imports the driver module graph so `lib/workspace-registry` (and
 * friends) can import `getStorage` from this file without a static cycle
 * through `LegacyJsonStorageDriver`.
 */
export async function getStorage(): Promise<StorageDriver> {
  if (activeDriver) return activeDriver;
  if (!initPromise) {
    initPromise = (async () => {
      const kind = resolveConfiguredDriverKind();
      const { instantiateDriver } = await import("./bootstrap-drivers.js");
      const driver = instantiateDriver(kind);
      await driver.init();
      activeDriver = driver;
      return driver;
    })();
  }
  return initPromise;
}

/** Synchronous access to an already-initialized driver. Throws if getStorage() hasn't been called. */
export function getStorageSync(): StorageDriver {
  if (!activeDriver) {
    throw new Error(
      "Storage driver is not initialized yet. Call getStorage() during bootstrap before any sync access."
    );
  }
  return activeDriver;
}

/** Test helper - swap the active driver (for fixtures that run the same suite against both). */
export function __setStorageForTesting(driver: StorageDriver | null): void {
  activeDriver = driver;
  initPromise = driver ? Promise.resolve(driver) : null;
}

async function legacyDataDirHasContent(): Promise<boolean> {
  try {
    const entries = await fs.readdir(DATA_DIR);
    return entries.some((entry) => !entry.startsWith("."));
  } catch {
    return false;
  }
}

let firstBootNoticeShown = false;

/**
 * First-boot helper: warms up the storage driver and, when the active driver is
 * `pg` but a legacy JSON data directory is still sitting on disk, prints a
 * one-time notice pointing the operator at the migration tooling. Kept quiet
 * under `NODE_ENV=test` so suites are not polluted by the banner.
 */
export async function bootstrapStorage(): Promise<StorageDriver> {
  const driver = await getStorage();
  if (process.env.NODE_ENV === "test") {
    return driver;
  }
  if (firstBootNoticeShown) return driver;
  const kind = resolveConfiguredDriverKind();
  if (kind === "pg" && (await legacyDataDirHasContent())) {
    firstBootNoticeShown = true;
    const banner = [
      "",
      "===========================================================================",
      "[storage] Postgres driver is active but a legacy JSON data directory exists:",
      `          ${DATA_DIR}`,
      "",
      "          To copy that data into Postgres, run:",
      "            npm --prefix server run storage:migrate -- --from legacy-json --to pg",
      "",
      "          To keep using the JSON driver instead, set:",
      "            OPENCURSOR_STORAGE_DRIVER=legacy-json",
      "===========================================================================",
      "",
    ].join("\n");
    console.warn(banner);
  } else {
    firstBootNoticeShown = true;
  }
  return driver;
}

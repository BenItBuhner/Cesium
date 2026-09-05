import type { StorageDriver, StorageDriverKind } from "./driver.js";

/**
 * Loads only the driver that was selected. The pg driver pulls in
 * drizzle-orm + postgres (~25 MB RSS, ~30 ms) - dead weight for the default
 * legacy-json deployment, which never talks to Postgres.
 */
export async function instantiateDriver(kind: StorageDriverKind): Promise<StorageDriver> {
  switch (kind) {
    case "legacy-json": {
      const { LegacyJsonStorageDriver } = await import("./legacy/index.js");
      return new LegacyJsonStorageDriver();
    }
    case "pg": {
      const { PgStorageDriver } = await import("./pg/index.js");
      return new PgStorageDriver();
    }
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unreachable storage driver kind: ${String(exhaustive)}`);
    }
  }
}

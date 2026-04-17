import type { StorageDriver, StorageDriverKind } from "./driver.js";
import { LegacyJsonStorageDriver } from "./legacy/index.js";
import { PgStorageDriver } from "./pg/index.js";

export function instantiateDriver(kind: StorageDriverKind): StorageDriver {
  switch (kind) {
    case "legacy-json":
      return new LegacyJsonStorageDriver();
    case "pg":
      return new PgStorageDriver();
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unreachable storage driver kind: ${String(exhaustive)}`);
    }
  }
}

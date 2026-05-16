import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";

import type { StorageDriver, StorageDriverKind } from "../../src/storage/driver.js";

export type StorageFixture = {
  kind: StorageDriverKind;
  driver: StorageDriver;
  /** Cleanup: reset DB tables / remove temp data dir / close connections. */
  cleanup: () => Promise<void>;
};

/**
 * Returns the list of driver kinds that can actually be exercised on this
 * machine. legacy-json is always available; pg requires DATABASE_URL_TEST
 * to point at a reachable Postgres 16 instance with the OSP-75 schema
 * applied.
 */
export function availableDriverKinds(): StorageDriverKind[] {
  const kinds: StorageDriverKind[] = ["legacy-json"];
  const pgUrl = process.env.DATABASE_URL_TEST?.trim();
  if (pgUrl && pgUrl.length > 0) {
    kinds.push("pg");
  }
  return kinds;
}

function requireTestDatabaseUrl(): string {
  const pgUrl = process.env.DATABASE_URL_TEST?.trim();
  if (!pgUrl) {
    throw new Error(
      "pg fixture requires DATABASE_URL_TEST. Refusing to fall back to DATABASE_URL."
    );
  }
  return pgUrl;
}

async function createLegacyFixture(): Promise<StorageFixture> {
  // OPENCURSOR_DATA_DIR must be set before persistence.js is first imported
  // because DATA_DIR is a module-scope const. Callers arrange this by calling
  // createFixture() prior to importing anything under src/lib/.
  const { LegacyJsonStorageDriver } = await import(
    "../../src/storage/legacy/index.js"
  );
  const driver = new LegacyJsonStorageDriver() as StorageDriver;
  await driver.init();

  const dataDir = process.env.OPENCURSOR_DATA_DIR!;
  return {
    kind: "legacy-json",
    driver,
    cleanup: async () => {
      await driver.close();
      await fs.rm(dataDir, { recursive: true, force: true }).catch(
        () => undefined
      );
    },
  };
}

async function createPgFixture(): Promise<StorageFixture> {
  const pgUrl = requireTestDatabaseUrl();
  process.env.DATABASE_URL = pgUrl;

  const [{ PgStorageDriver }, { getDb }] = await Promise.all([
    import("../../src/storage/pg/index.js"),
    import("../../src/db/client.js"),
  ]);

  const driver = new PgStorageDriver() as StorageDriver;
  await driver.init();

  // Wipe all tables so consecutive test runs start clean. TRUNCATE ... CASCADE
  // handles FK chains in one shot.
  const db = getDb();
  await db.execute(sql`
    TRUNCATE TABLE
      agent_events,
      agent_conversations,
      fs_attachments,
      workspace_sessions,
      workspace_windows,
      workspaces,
      workspace_profile,
      global_settings,
      auth_sessions,
      auth_state,
      provider_cache
    RESTART IDENTITY CASCADE;
  `);

  return {
    kind: "pg",
    driver,
    cleanup: async () => {
      await driver.close();
      // Leave the pool open so subsequent fixture acquisitions can reuse it;
      // final teardown happens in the process shutdown hooks in db/client.ts.
    },
  };
}

/**
 * Bootstrap env vars for the requested driver BEFORE any src/lib/ module is
 * imported. Must be called once at test-file top-level, before the dynamic
 * imports of the modules under test.
 */
export function bootstrapFixtureEnv(kind: StorageDriverKind): string {
  switch (kind) {
    case "legacy-json": {
      const dataDir = path.join(
        os.tmpdir(),
        `cesium-storage-test-${Date.now()}-${randomUUID().slice(0, 8)}`
      );
      process.env.OPENCURSOR_DATA_DIR = dataDir;
      return dataDir;
    }
    case "pg": {
      const pgUrl = requireTestDatabaseUrl();
      process.env.DATABASE_URL = pgUrl;
      return pgUrl;
    }
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unknown driver kind: ${String(exhaustive)}`);
    }
  }
}

export async function createFixture(kind: StorageDriverKind): Promise<StorageFixture> {
  switch (kind) {
    case "legacy-json":
      return createLegacyFixture();
    case "pg":
      return createPgFixture();
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unknown driver kind: ${String(exhaustive)}`);
    }
  }
}

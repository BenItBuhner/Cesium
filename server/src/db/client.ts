import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema.js";

type DrizzleClient = ReturnType<typeof drizzle<typeof schema>>;

let pool: Sql | null = null;
let db: DrizzleClient | null = null;
let shutdownRegistered = false;

function resolveDatabaseUrl(): string | null {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw || raw.length === 0) return null;
  // On Windows, `localhost` often resolves to `::1` first and Docker's IPv6
  // binding can be flaky (we've seen 10s CONNECT_TIMEOUTs against
  // `localhost:5433` even though `127.0.0.1:5433` is healthy). Force IPv4 so
  // the first query doesn't eat a full connect-timeout window.
  try {
    const url = new URL(raw);
    if (url.hostname === "localhost") {
      url.hostname = "127.0.0.1";
      return url.toString();
    }
  } catch {
    // fall through with raw value if URL parsing fails
  }
  return raw;
}

export function hasDatabaseUrl(): boolean {
  return resolveDatabaseUrl() !== null;
}

/**
 * Returns the Drizzle client, constructing the pool on first access.
 * Throws if DATABASE_URL is not set; callers should gate on `hasDatabaseUrl()`
 * when running under the legacy-json driver.
 */
export function getDb(): DrizzleClient {
  if (db) return db;

  const url = resolveDatabaseUrl();
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Configure it or switch OPENCURSOR_STORAGE_DRIVER=legacy-json."
    );
  }

  const poolMax = Number.parseInt(process.env.DATABASE_POOL_MAX ?? "10", 10);
  const idleTimeout = Number.parseInt(
    process.env.DATABASE_IDLE_TIMEOUT_SEC ?? "20",
    10
  );
  const connectTimeout = Number.parseInt(
    process.env.DATABASE_CONNECT_TIMEOUT_SEC ?? "30",
    10
  );

  pool = postgres(url, {
    max: Number.isFinite(poolMax) && poolMax > 0 ? poolMax : 10,
    idle_timeout: Number.isFinite(idleTimeout) ? idleTimeout : 20,
    connect_timeout: Number.isFinite(connectTimeout) ? connectTimeout : 30,
    prepare: true,
    // Skip the synchronous pg_type roundtrip on every new connection. We
    // don't rely on custom type parsing and this shaves a full RTT off
    // cold-start latency when the pool needs to grow.
    fetch_types: false,
    // Swallow transient socket errors on idle connections instead of
    // surfacing them as unhandled exceptions; the pool will reconnect on
    // the next query.
    onnotice: () => undefined,
  });
  db = drizzle(pool, { schema, casing: "snake_case" });
  registerShutdown();
  return db;
}

/**
 * Opens and verifies the pool eagerly so the first real query doesn't pay
 * the cold-start cost (and doesn't trip a CONNECT_TIMEOUT if the DB is
 * momentarily slow). Safe to call multiple times.
 */
export async function warmupDb(): Promise<void> {
  if (!hasDatabaseUrl()) return;
  try {
    const client = getDb();
    // A tiny round-trip to force the pool to establish its first connection.
    await client.execute("select 1");
  } catch (error) {
    console.warn("[db] warmup failed (will retry on first query):", error);
  }
}

export function getPgPool(): Sql {
  getDb();
  return pool!;
}

function registerShutdown(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  const shutdown = async () => {
    const localPool = pool;
    pool = null;
    db = null;
    if (localPool) {
      await localPool.end({ timeout: 5 }).catch(() => undefined);
    }
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
  process.once("beforeExit", () => {
    void shutdown();
  });
}

/** Test helper - close and reset the pool so a follow-up call rebuilds it. */
export async function closeDb(): Promise<void> {
  const localPool = pool;
  pool = null;
  db = null;
  if (localPool) {
    await localPool.end({ timeout: 5 }).catch(() => undefined);
  }
}

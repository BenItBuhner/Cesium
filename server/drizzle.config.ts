import type { Config } from "drizzle-kit";

const DEFAULT_DEV_URL =
  "postgres://cesium:cesium@localhost:5433/cesium";

export default {
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  casing: "snake_case",
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_URL?.trim() || DEFAULT_DEV_URL,
  },
} satisfies Config;

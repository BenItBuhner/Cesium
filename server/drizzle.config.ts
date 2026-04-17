import type { Config } from "drizzle-kit";

const DEFAULT_DEV_URL =
  "postgres://opencursor:opencursor@localhost:5433/opencursor";

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

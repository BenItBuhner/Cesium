/**
 * Load env before other modules read process.env.
 * Order: repo `.env` → repo `.env.local` → `server/.env` → `server/.env.local` (each overrides previous).
 */
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, "..");
const repoRoot = path.resolve(serverDir, "..");

config({ path: path.join(repoRoot, ".env") });
config({ path: path.join(repoRoot, ".env.local"), override: true });
config({ path: path.join(serverDir, ".env"), override: true });
config({ path: path.join(serverDir, ".env.local"), override: true });

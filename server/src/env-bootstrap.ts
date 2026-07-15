/**
 * Load env before other modules read process.env.
 * File order: repo `.env` → repo `.env.local` → `server/.env` → `server/.env.local`.
 *
 * File-local overrides still work, but real process env wins. That lets Docker,
 * systemd, CI, and one-off smoke runs override checked-in/local `.env` values.
 */
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, "..");
const repoRoot = path.resolve(serverDir, "..");

const originalEnv = { ...process.env };

config({ path: path.join(repoRoot, ".env") });
config({ path: path.join(repoRoot, ".env.local"), override: true });
config({ path: path.join(serverDir, ".env"), override: true });
config({ path: path.join(serverDir, ".env.local"), override: true });

for (const [key, value] of Object.entries(originalEnv)) {
  process.env[key] = value;
}

const processName = process.env.OPENCURSOR_PROCESS_NAME?.trim();
if (processName) {
  process.title = processName;
} else if (process.env.OPENCURSOR_DESKTOP_BACKEND === "1") {
  process.title = "Cesium Server";
}

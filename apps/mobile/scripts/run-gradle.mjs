import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const androidRoot = path.join(mobileRoot, "android");
const executable = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
const result = spawnSync(executable, process.argv.slice(2), {
  cwd: androidRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);

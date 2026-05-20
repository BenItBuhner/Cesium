const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const serverPackagePath = path.join(repoRoot, "server", "package.json");
const stagingRoot = path.join(repoRoot, "apps", "desktop", ".server-runtime");

async function main() {
  const serverPackage = JSON.parse(await fs.readFile(serverPackagePath, "utf8"));
  const dependencies = Object.fromEntries(
    Object.entries(serverPackage.dependencies ?? {}).filter(
      ([, version]) => typeof version === "string" && !version.startsWith("file:")
    )
  );

  await fs.rm(stagingRoot, { recursive: true, force: true });
  await fs.mkdir(stagingRoot, { recursive: true });
  await fs.writeFile(
    path.join(stagingRoot, "package.json"),
    JSON.stringify(
      {
        name: "cesium-desktop-server-runtime",
        private: true,
        type: "module",
        dependencies,
      },
      null,
      2
    )
  );

  const result = spawnSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: stagingRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

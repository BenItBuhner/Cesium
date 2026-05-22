const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const serverPackagePath = path.join(repoRoot, "server", "package.json");
const stagingRoot = path.join(repoRoot, "apps", "desktop", ".server-runtime");
const localWorkspacePackages = {
  "@cesium/core": path.join(repoRoot, "packages", "core"),
};

async function copyLocalWorkspacePackage(packageName, sourceRoot) {
  const packageJsonPath = path.join(sourceRoot, "package.json");
  const distPath = path.join(sourceRoot, "dist");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  const targetRoot = path.join(stagingRoot, "node_modules", ...packageName.split("/"));

  await fs.rm(targetRoot, { recursive: true, force: true });
  await fs.mkdir(targetRoot, { recursive: true });
  await fs.writeFile(
    path.join(targetRoot, "package.json"),
    JSON.stringify(
      {
        name: packageJson.name,
        version: packageJson.version,
        type: packageJson.type,
        main: packageJson.main,
        types: packageJson.types,
        exports: packageJson.exports,
      },
      null,
      2
    )
  );
  await fs.cp(distPath, path.join(targetRoot, "dist"), {
    recursive: true,
    force: true,
  });
}

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

  for (const [packageName, sourceRoot] of Object.entries(localWorkspacePackages)) {
    if (serverPackage.dependencies?.[packageName]?.startsWith("file:")) {
      await copyLocalWorkspacePackage(packageName, sourceRoot);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

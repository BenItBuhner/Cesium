const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const serverPackagePath = path.join(repoRoot, "server", "package.json");
const stagingRoot = path.join(repoRoot, "apps", "desktop", ".server-runtime");

/**
 * Workspace packages the server depends on via `file:` links. These must be
 * staged into the packaged runtime by hand: npm cannot install them from a
 * registry, and the packaged app cannot rely on the repo checkout's
 * node_modules being an ancestor of the install location (that accident made
 * missing packages invisible when testing builds from inside the repo).
 * The recursive `cesium` root link is excluded on purpose.
 */
function resolveLocalWorkspacePackages(serverPackage) {
  const packages = {};
  for (const [name, version] of Object.entries(serverPackage.dependencies ?? {})) {
    if (name === "cesium" || typeof version !== "string" || !version.startsWith("file:")) {
      continue;
    }
    packages[name] = path.resolve(path.join(repoRoot, "server"), version.slice("file:".length));
  }
  return packages;
}

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
  const localWorkspacePackages = resolveLocalWorkspacePackages(serverPackage);
  const dependencies = Object.fromEntries(
    Object.entries(serverPackage.dependencies ?? {}).filter(
      ([, version]) => typeof version === "string" && !version.startsWith("file:")
    )
  );

  // Local workspace packages may have external runtime deps of their own
  // (e.g. @cesium/contracts -> zod). Install them explicitly instead of
  // hoping some transitive dependency happens to provide them.
  for (const sourceRoot of Object.values(localWorkspacePackages)) {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(sourceRoot, "package.json"), "utf8")
    );
    for (const [name, version] of Object.entries(packageJson.dependencies ?? {})) {
      if (name.startsWith("@cesium/") || typeof version !== "string" || version.startsWith("file:")) {
        continue;
      }
      dependencies[name] ??= version;
    }
  }

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

  // Windows keeps the historic `node.exe` name; POSIX (macOS/Linux) stages a
  // plain executable `node`. `electron-builder.config.cjs` picks the matching
  // resource per platform.
  const nodeBinName = process.platform === "win32" ? "node.exe" : "node";
  const stagedNode = path.join(stagingRoot, nodeBinName);
  await fs.copyFile(process.execPath, stagedNode);
  if (process.platform !== "win32") {
    await fs.chmod(stagedNode, 0o755);
  }
  console.log("Bundled Node.js runtime for desktop backend startup.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

const fs = require("node:fs/promises");
const path = require("node:path");

async function editExecutable(exePath, strings, iconPath) {
  const { rcedit } = await import("rcedit");
  const options = {
    "version-string": strings,
  };
  if (iconPath) {
    options.icon = iconPath;
  }
  await rcedit(exePath, options);
}

async function copyIfMissing(source, target) {
  try {
    await fs.access(target);
    return;
  } catch {
    await fs.copyFile(source, target);
  }
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function editWindowsExecutables(outDir, options = {}) {
  const repoRoot = options.repoRoot || path.resolve(__dirname, "..");
  const appDir = path.join(repoRoot, "apps", "desktop");
  const packageJson = require(path.join(appDir, "package.json"));
  const desktopExe = path.join(outDir, "Cesium.exe");
  const serverExe = path.join(outDir, "Cesium Server.exe");
  const iconPath = options.iconPath || path.join(appDir, "build", "icon.ico");
  const version = packageJson.version || "0.0.0";

  if (!(await pathExists(desktopExe))) {
    throw new Error(`Missing Windows desktop executable: ${desktopExe}`);
  }
  if (!(await pathExists(iconPath))) {
    throw new Error(`Missing Windows icon: ${iconPath}`);
  }

  await editExecutable(
    desktopExe,
    {
      CompanyName: "Cesium",
      FileDescription: "Cesium Desktop",
      InternalName: "Cesium Desktop",
      OriginalFilename: "Cesium.exe",
      ProductName: "Cesium Desktop",
      ProductVersion: version,
    },
    iconPath
  );

  await copyIfMissing(desktopExe, serverExe);
  await editExecutable(
    serverExe,
    {
      CompanyName: "Cesium",
      FileDescription: "Cesium Server",
      InternalName: "Cesium Server",
      OriginalFilename: "Cesium Server.exe",
      ProductName: "Cesium Server",
      ProductVersion: version,
    },
    iconPath
  );

  console.log(`Edited Windows executable metadata in ${outDir}`);
}

async function main() {
  if (process.platform !== "win32") {
    return;
  }

  const repoRoot = path.resolve(__dirname, "..");
  const outDir = path.join(repoRoot, "apps", "desktop", "out", "win-unpacked");
  await editWindowsExecutables(outDir, { repoRoot });
}

module.exports = {
  editExecutable,
  editWindowsExecutables,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  });
}

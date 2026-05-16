const fs = require("node:fs/promises");
const { execFile } = require("node:child_process");
const path = require("node:path");

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function runPowerShell(script, env = {}) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      {
        env: { ...process.env, ...env },
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || stdout || error.message).trim()));
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}

async function getWindowsKnownFolders() {
  try {
    const output = await runPowerShell(`
$folders = @{
  Programs = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)
  Desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
}
$folders | ConvertTo-Json -Compress
`);
    return JSON.parse(output);
  } catch {
    return {
      Programs: process.env.APPDATA
        ? path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs")
        : "",
      Desktop: process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "Desktop") : "",
    };
  }
}

async function createShortcut(shortcutPath, exePath) {
  await fs.mkdir(path.dirname(shortcutPath), { recursive: true });
  await runPowerShell(
    `
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($env:CESIUM_SHORTCUT_PATH)
$shortcut.TargetPath = $env:CESIUM_EXE_PATH
$shortcut.WorkingDirectory = $env:CESIUM_INSTALL_DIR
$shortcut.Description = "Cesium"
$shortcut.IconLocation = "$env:CESIUM_EXE_PATH,0"
$shortcut.Save()
`,
    {
      CESIUM_SHORTCUT_PATH: shortcutPath,
      CESIUM_EXE_PATH: exePath,
      CESIUM_INSTALL_DIR: path.dirname(exePath),
    }
  );
}

async function removeShortcutIfTargetsKnownInstall(shortcutPath, knownInstallRoots) {
  if (!(await pathExists(shortcutPath))) {
    return false;
  }

  const result = await runPowerShell(
    `
$shortcutPath = $env:CESIUM_SHORTCUT_PATH
if (!(Test-Path -LiteralPath $shortcutPath)) {
  Write-Output "missing"
  exit 0
}
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
$targetPath = $shortcut.TargetPath
if ([string]::IsNullOrWhiteSpace($targetPath)) {
  Write-Output "skipped"
  exit 0
}
$targetPath = [System.IO.Path]::GetFullPath($targetPath)
$roots = $env:CESIUM_STALE_SHORTCUT_ROOTS | ConvertFrom-Json
foreach ($root in $roots) {
  if ([string]::IsNullOrWhiteSpace($root)) {
    continue
  }
  $rootPath = [System.IO.Path]::GetFullPath($root)
  if ($targetPath.StartsWith($rootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $shortcutPath -Force
    Write-Output "removed"
    exit 0
  }
}
Write-Output "skipped"
`,
    {
      CESIUM_SHORTCUT_PATH: shortcutPath,
      CESIUM_STALE_SHORTCUT_ROOTS: JSON.stringify(knownInstallRoots),
    }
  );
  return result === "removed";
}

async function installShortcuts(exe, target, localAppData) {
  const knownFolders = await getWindowsKnownFolders();
  const shortcutDirs = [
    knownFolders.Programs,
    knownFolders.Desktop,
  ].filter(Boolean);

  for (const dir of shortcutDirs) {
    await createShortcut(path.join(dir, "Cesium.lnk"), exe);
  }

  const oldInstallRoots = [
    target,
    path.resolve(localAppData, "Programs", "OpenCursor"),
    path.resolve(localAppData, "OpenCursor"),
  ];
  const staleShortcutNames = ["OpenCursor.lnk", "Open Cursor.lnk"];
  for (const dir of shortcutDirs) {
    for (const shortcutName of staleShortcutNames) {
      const removed = await removeShortcutIfTargetsKnownInstall(
        path.join(dir, shortcutName),
        oldInstallRoots
      );
      if (removed) {
        console.log(`Removed stale shortcut: ${path.join(dir, shortcutName)}`);
      }
    }
  }
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("install:desktop:unpacked is currently intended for Windows builds.");
  }

  const repoRoot = path.resolve(__dirname, "..");
  const source = path.resolve(repoRoot, "apps", "desktop", "out", "win-unpacked");
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error("LOCALAPPDATA is not set.");
  }

  if (!(await pathExists(source))) {
    throw new Error(`Missing unpacked build at ${source}. Run npm run package --workspace @cesium/desktop first.`);
  }

  const target = path.resolve(localAppData, "Programs", "Cesium");
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true, force: true, dereference: true });

  const exe = path.join(target, "Cesium.exe");
  if (!(await pathExists(exe))) {
    throw new Error(`Installed directory does not contain Cesium.exe: ${exe}`);
  }
  await installShortcuts(exe, target, localAppData);

  console.log(`Installed Cesium unpacked build to ${target}`);
  console.log(`Launch executable: ${exe}`);
  console.log("Created shortcuts named Cesium in Start Menu and Desktop.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

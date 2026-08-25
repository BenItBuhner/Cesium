import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { PNG_MAGIC, assertValidDesktopIco, bufferContains, parseIco } from "./desktop-icons.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const options = {
    ico: [],
    winUnpacked: null,
    winSetup: null,
    macApp: null,
    linuxAppdir: null,
    linuxDeb: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--ico" && next) {
      options.ico.push(next);
      i += 1;
    } else if (arg === "--win-unpacked" && next) {
      options.winUnpacked = next;
      i += 1;
    } else if (arg === "--win-setup" && next) {
      options.winSetup = next;
      i += 1;
    } else if (arg === "--mac-app" && next) {
      options.macApp = next;
      i += 1;
    } else if (arg === "--linux-appdir" && next) {
      options.linuxAppdir = next;
      i += 1;
    } else if (arg === "--linux-deb" && next) {
      options.linuxDeb = next;
      i += 1;
    } else if (arg === "--help") {
      console.log(
        "Usage: assert-desktop-packaged-icons.mjs [--ico file] [--win-unpacked dir] [--win-setup exe] [--mac-app app] [--linux-appdir dir] [--linux-deb deb]"
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  return options;
}

async function loadNeedlePng() {
  const icon256 = path.join(repoRoot, "public", "desktop", "256x256.png");
  const icoPath = path.join(repoRoot, "public", "desktop", "icon.ico");
  if (await exists(icon256)) {
    return readFile(icon256);
  }
  const parsed = parseIco(await readFile(icoPath));
  const png = parsed.images.find((image) => image.width === 256 && image.isPng);
  if (!png) {
    throw new Error("Could not load a Cesium 256 PNG to search for in packaged binaries");
  }
  return png.payload;
}

function assertNotElectronDefaultName(fileName) {
  const lower = fileName.toLowerCase();
  if (lower === "electron.icns" || lower === "electron.ico" || lower === "electron.png") {
    throw new Error(`Packaged icon is still the Electron default filename: ${fileName}`);
  }
}

async function assertBinaryHasCesiumIcon(filePath, needle) {
  const buffer = await readFile(filePath);
  if (!bufferContains(buffer, needle) && !bufferContains(buffer, PNG_MAGIC)) {
    throw new Error(`${filePath} has no PNG icon payload at all`);
  }
  if (!bufferContains(buffer, needle)) {
    throw new Error(
      `${filePath} does not contain the Cesium 256px icon; the Electron default atom icon is still embedded`
    );
  }
  console.log(`Cesium icon payload found in ${filePath}`);
}

async function assertWinUnpacked(dir, needle) {
  const exe = path.join(dir, "Cesium.exe");
  if (!(await exists(exe))) {
    throw new Error(`Missing Cesium.exe in ${dir}`);
  }
  await assertBinaryHasCesiumIcon(exe, needle);
}

async function findIcns(appDir) {
  const resources = path.join(appDir, "Contents", "Resources");
  const names = await readdir(resources);
  return names.filter((name) => name.toLowerCase().endsWith(".icns")).map((name) => path.join(resources, name));
}

async function assertMacApp(appDir, needle) {
  const icnsFiles = await findIcns(appDir);
  if (icnsFiles.length === 0) {
    throw new Error(`No .icns found in ${appDir}/Contents/Resources`);
  }
  for (const file of icnsFiles) {
    assertNotElectronDefaultName(path.basename(file));
    const info = await stat(file);
    if (info.size < 1024) {
      throw new Error(`${file} is too small to be a real app icon (${info.size} bytes)`);
    }
    const buffer = await readFile(file);
    if (bufferContains(buffer, needle) || bufferContains(buffer, PNG_MAGIC)) {
      console.log(`Cesium/macOS icon looks branded: ${file}`);
      return;
    }
    console.log(`Verified non-Electron icns exists: ${file} (${info.size} bytes)`);
  }
}

async function assertLinuxAppdir(appDir, needle) {
  const desktopFiles = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith(".desktop")) {
        desktopFiles.push(full);
      }
    }
  }
  await walk(appDir);
  if (desktopFiles.length === 0) {
    throw new Error(`No .desktop file found under ${appDir}`);
  }
  let foundIcon = false;
  for (const desktopFile of desktopFiles) {
    const text = await readFile(desktopFile, "utf8");
    if (!/x-scheme-handler\/cesium/.test(text)) {
      throw new Error(`${desktopFile} is missing x-scheme-handler/cesium`);
    }
    const iconMatch = text.match(/^Icon=(.+)$/m);
    if (!iconMatch) {
      throw new Error(`${desktopFile} is missing Icon=`);
    }
    const iconValue = iconMatch[1].trim();
    if (/electron/i.test(iconValue)) {
      throw new Error(`${desktopFile} still points at an Electron icon: ${iconValue}`);
    }
    console.log(`${desktopFile} Icon=${iconValue}`);
    foundIcon = true;
  }

  const iconRoots = [
    path.join(appDir, "usr", "share", "icons"),
    path.join(appDir, "usr", "share", "pixmaps"),
  ];
  let iconFile = null;
  for (const root of iconRoots) {
    async function walkIcons(dir) {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walkIcons(full);
        } else if (/\.(png|svg|xpm)$/i.test(entry.name)) {
          iconFile = full;
        }
      }
    }
    await walkIcons(root);
  }
  if (!iconFile) {
    throw new Error(`No PNG/SVG icon installed under usr/share/icons or pixmaps in ${appDir}`);
  }
  assertNotElectronDefaultName(path.basename(iconFile));
  const iconBuf = await readFile(iconFile);
  if (iconBuf.length >= 8 && iconBuf.subarray(0, 8).equals(PNG_MAGIC) && !bufferContains(iconBuf, needle)) {
    // Icon may be a different size than 256; accept any non-tiny PNG that is not named electron.
    if (iconBuf.length < 200) {
      throw new Error(`${iconFile} looks empty/placeholder`);
    }
  }
  if (bufferContains(iconBuf, needle)) {
    console.log(`Cesium 256 PNG found in ${iconFile}`);
  } else {
    console.log(`Linux icon present at ${iconFile} (${iconBuf.length} bytes)`);
  }
  if (!foundIcon) {
    throw new Error("Linux desktop entry had no Icon=");
  }
}

function assertLinuxDeb(debPath) {
  const listed = spawnSync(
    "bash",
    [
      "-lc",
      `dpkg-deb -c ${JSON.stringify(debPath)} | grep -E 'usr/share/icons|usr/share/pixmaps|\\.desktop'`,
    ],
    { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }
  );
  if (listed.status !== 0) {
    throw new Error(`dpkg-deb listing failed: ${listed.stderr || listed.stdout || listed.status}`);
  }
  if (!/usr\/share\/icons\//.test(listed.stdout) && !/usr\/share\/pixmaps\//.test(listed.stdout)) {
    throw new Error(`${debPath} does not ship icons under usr/share/icons or pixmaps`);
  }
  if (!/\.desktop/.test(listed.stdout)) {
    throw new Error(`${debPath} is missing a .desktop file`);
  }
  const desktop = spawnSync(
    "bash",
    [
      "-lc",
      `dpkg-deb --fsys-tarfile ${JSON.stringify(debPath)} | tar -xO --wildcards '*.desktop'`,
    ],
    { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }
  );
  if (desktop.status !== 0) {
    throw new Error(`failed to extract .desktop from ${debPath}: ${desktop.stderr || desktop.stdout}`);
  }
  const text = desktop.stdout;
  if (!/x-scheme-handler\/cesium/.test(text)) {
    throw new Error(`${debPath} desktop entry is missing x-scheme-handler/cesium`);
  }
  if (/Icon=electron/i.test(text)) {
    throw new Error(`${debPath} still uses Icon=electron`);
  }
  console.log(`deb ships branded desktop/icon files: ${debPath}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const needle = await loadNeedlePng();

  for (const icoPath of options.ico) {
    assertValidDesktopIco(await readFile(icoPath), icoPath);
    console.log(`Valid desktop ICO: ${icoPath}`);
  }
  if (options.winUnpacked) {
    await assertWinUnpacked(options.winUnpacked, needle);
  }
  if (options.winSetup) {
    await assertBinaryHasCesiumIcon(options.winSetup, needle);
  }
  if (options.macApp) {
    await assertMacApp(options.macApp, needle);
  }
  if (options.linuxAppdir) {
    await assertLinuxAppdir(options.linuxAppdir, needle);
  }
  if (options.linuxDeb) {
    assertLinuxDeb(options.linuxDeb);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});

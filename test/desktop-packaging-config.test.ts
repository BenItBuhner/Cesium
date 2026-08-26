import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const config = require("../apps/desktop/electron-builder.config.cjs");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Windows NSIS is one-click with Cesium installer icons and no license page", () => {
  assert.equal(config.nsis.oneClick, true);
  assert.equal(config.nsis.perMachine, false);
  assert.equal(config.nsis.allowToChangeInstallationDirectory, false);
  assert.equal(config.nsis.license, undefined);
  assert.equal(config.nsis.installerIcon, "build/icon.ico");
  assert.equal(config.nsis.uninstallerIcon, "build/icon.ico");
  assert.equal(config.nsis.include, "installer.nsh");
  assert.equal(config.nsis.shortcutName, "Cesium");
  assert.equal(config.nsis.createDesktopShortcut, true);
  assert.equal(config.nsis.createStartMenuShortcut, true);
  assert.equal(config.win.artifactName, "cesium-desktop-${version}-win-${arch}-setup.${ext}");
  assert.equal(typeof config.afterPack, "function");
});

test("NSIS include forces Programs\\Cesium and removes the #214 @cesiumdesktop path", () => {
  const nsh = readFileSync(path.join(repoRoot, "apps/desktop/installer.nsh"), "utf8");
  assert.match(nsh, /!macro preInit/);
  assert.match(nsh, /InstallLocation "\$LOCALAPPDATA\\Programs\\Cesium"/);
  assert.match(nsh, /RMDir \/r "\$LOCALAPPDATA\\Programs\\@cesiumdesktop"/);
});

test("Linux packaging uses the icon pyramid directory", () => {
  assert.equal(config.linux.icon, "build/icons");
});

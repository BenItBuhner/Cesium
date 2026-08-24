import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const config = require("../apps/desktop/electron-builder.config.cjs");

test("Windows NSIS is one-click with Cesium installer icons and no license page", () => {
  assert.equal(config.nsis.oneClick, true);
  assert.equal(config.nsis.perMachine, false);
  assert.equal(config.nsis.allowToChangeInstallationDirectory, false);
  assert.equal(config.nsis.license, undefined);
  assert.equal(config.nsis.installerIcon, "build/icon.ico");
  assert.equal(config.nsis.uninstallerIcon, "build/icon.ico");
  assert.equal(config.nsis.include, "installer.nsh");
  assert.equal(typeof config.afterPack, "function");
});

test("Linux packaging uses the icon pyramid directory", () => {
  assert.equal(config.linux.icon, "build/icons");
});

test("one-click per-user install folder is Cesium, not the scoped package name", () => {
  assert.equal(config.extraMetadata.name, "Cesium");
});

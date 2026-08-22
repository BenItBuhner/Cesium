/**
 * electron-builder configuration for Cesium Desktop (moved out of
 * package.json so the staged Node runtime resource can be platform-aware:
 * `.server-runtime/node.exe` on Windows, `.server-runtime/node` on POSIX).
 */

const isWindows = process.platform === "win32";

// Packages always target the build host's CPU architecture: the staged
// backend runtime (`.server-runtime/node`) is a copy of the running Node
// binary and native modules are compiled in place during staging, so a
// cross-arch electron-builder invocation would embed wrong-arch binaries.
// CI builds each architecture on a native runner instead.
const hostArch = process.arch === "arm64" ? "arm64" : "x64";

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "com.cesium.desktop",
  productName: "Cesium Desktop",
  npmRebuild: false,
  directories: {
    output: "out",
  },
  compression: "store",
  files: ["src/**/*", "build/**/*", "package.json"],
  icon: isWindows ? "build/icon.ico" : "build/icon.png",
  // Registers cesium:// in the packaged app's metadata (Info.plist
  // CFBundleURLTypes on macOS); runtime setAsDefaultProtocolClient covers
  // Windows/Linux.
  protocols: [
    {
      name: "Cesium",
      schemes: ["cesium"],
    },
  ],
  extraResources: [
    { from: "build/icon.png", to: "build/icon.png" },
    { from: "build/icon.ico", to: "build/icon.ico" },
    { from: "../../server/dist", to: "server/dist" },
    { from: "../../server/package.json", to: "server/package.json" },
    {
      from: ".server-runtime/node_modules",
      to: "server/node_modules",
      filter: [
        "**/*",
        "!cesium/**",
        "!**/cesium/**",
        "!**/g/caches/**",
        "!**/.gradle/**",
        "!**/android/**",
        "!**/.cache/**",
        "!**/node_modules/.cache/**",
        "!**/.local-browsers/**",
      ],
    },
    isWindows
      ? { from: ".server-runtime/node.exe", to: "server/node.exe" }
      : { from: ".server-runtime/node", to: "server/node" },
    { from: "../desktop-renderer/dist", to: "desktop-renderer" },
  ],
  win: {
    executableName: "Cesium",
    icon: "build/icon.ico",
    signAndEditExecutable: false,
    target: [{ target: "nsis", arch: [hostArch] }],
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    runAfterFinish: true,
    shortcutName: "Cesium",
    uninstallDisplayName: "Cesium",
    license: "build/terms.txt",
  },
  linux: {
    executableName: "cesium-desktop",
    artifactName: "cesium-desktop-${version}-${arch}.${ext}",
    target: [
      { target: "AppImage", arch: [hostArch] },
      { target: "deb", arch: [hostArch] },
    ],
    icon: "build/icon.png",
    category: "Development",
    maintainer: "Cesium <cesium@localhost>",
    synopsis: "Cesium Desktop AI workbench",
    // "Open with Cesium" targets for the share-intake path (the cesium://
    // scheme handler is added automatically from `protocols`).
    mimeTypes: [
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/json",
      "application/pdf",
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
    ],
    desktop: {
      entry: {
        StartupWMClass: "Cesium Desktop",
      },
    },
  },
  mac: {
    target: [
      { target: "dmg", arch: [hostArch] },
      { target: "zip", arch: [hostArch] },
    ],
    icon: "build/icon.png",
    category: "public.app-category.developer-tools",
    darkModeSupport: true,
    // Unsigned local/CI builds; distribution signing happens elsewhere.
    identity: null,
    extendInfo: {
      // "Open with Cesium" / dock drops feed the share-intake UI via the
      // app's open-file handler.
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: "Cesium Shared Item",
          CFBundleTypeRole: "Viewer",
          LSHandlerRank: "Alternate",
          LSItemContentTypes: ["public.data", "public.text", "public.image"],
        },
      ],
    },
  },
  dmg: {
    writeUpdateInfo: false,
  },
};

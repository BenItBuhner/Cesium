const path = require("node:path");
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");

const repoRoot = path.resolve(__dirname, "../..");
const mobileNodeModules = path.resolve(__dirname, "node_modules");
const forceMobileModule = (moduleName) =>
  moduleName === "react" ||
  moduleName.startsWith("react/") ||
  moduleName === "react-native" ||
  moduleName.startsWith("react-native/");

const config = {
  projectRoot: __dirname,
  watchFolders: [repoRoot],
  resolver: {
    nodeModulesPaths: [
      mobileNodeModules,
      path.resolve(repoRoot, "node_modules"),
    ],
    extraNodeModules: {
      react: path.resolve(mobileNodeModules, "react"),
      "react-native": path.resolve(mobileNodeModules, "react-native"),
    },
    resolveRequest(context, moduleName, platform) {
      if (forceMobileModule(moduleName)) {
        return {
          type: "sourceFile",
          filePath: require.resolve(moduleName, { paths: [mobileNodeModules] }),
        };
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);

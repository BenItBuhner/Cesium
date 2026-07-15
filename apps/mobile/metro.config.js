const path = require("node:path");
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");
const { withNativewind } = require("nativewind/metro");

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

const nativewindConfig = withNativewind(mergeConfig(getDefaultConfig(__dirname), config));

// Re-route the transformer through our wrapper (see metro-transformer.js): it
// delegates to react-native-css's transformer but converts Expo's packed
// source maps back to the tuple arrays bare Metro's serializer expects.
nativewindConfig.transformerPath = require.resolve("./metro-transformer");

module.exports = nativewindConfig;

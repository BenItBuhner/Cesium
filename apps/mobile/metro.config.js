const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(projectRoot);

config.resolver = config.resolver ?? {};
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  react: path.join(workspaceRoot, "node_modules/react"),
  "react-dom": path.join(workspaceRoot, "node_modules/react-dom"),
  scheduler: path.join(workspaceRoot, "node_modules/scheduler"),
};

module.exports = config;

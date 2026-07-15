/**
 * Wraps react-native-css's metro transformer (which delegates to
 * @expo/metro-config's transform worker) for use with the bare React Native
 * CLI. Expo's worker emits `SerializableSourceMap` packed maps that only Expo
 * CLI's patched Bundler can read; bare Metro's serializer requires plain
 * raw-mapping tuple arrays and throws "Unexpected module with full source map
 * found" otherwise. Materialize packed maps back to tuples inside the worker.
 */
const path = require("node:path");

const reactNativeCssMetroDir = path.dirname(require.resolve("react-native-css/metro"));
// Internal file (not in package exports) — absolute-path require bypasses exports.
const upstream = require(path.join(reactNativeCssMetroDir, "metro-transformer.js"));

const expoMetroConfigDir = path.dirname(require.resolve("@expo/metro-config"));
const { isSerializableSourceMap, materializeMap } = require(
  path.join(expoMetroConfigDir, "serializer", "packedMap.js")
);

async function transform(config, projectRoot, filePath, data, options) {
  const result = await upstream.transform(config, projectRoot, filePath, data, options);
  for (const output of result?.output ?? []) {
    const outputData = output?.data;
    if (outputData && isSerializableSourceMap(outputData.map)) {
      outputData.map = materializeMap(outputData.map);
    }
  }
  return result;
}

module.exports = { ...upstream, transform };

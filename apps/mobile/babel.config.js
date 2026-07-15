module.exports = {
  // nativewind/babel rewrites `react-native` imports to react-native-css's
  // className-aware wrappers and already includes react-native-worklets/plugin.
  presets: ["module:@react-native/babel-preset", "nativewind/babel"],
};

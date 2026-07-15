module.exports = {
  dependencies: {
    // Build-time only: @expo/metro-config's transform worker (used by
    // react-native-css/NativeWind v5) resolves the expo package at bundle
    // time. Never link its native code into the app.
    expo: {
      platforms: {
        android: null,
        ios: null,
      },
    },
  },
};

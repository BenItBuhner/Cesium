module.exports = {
  testRunner: {
    args: {
      "$0": "jest",
      config: "e2e/detox/jest.config.js",
    },
    jest: {
      setupTimeout: 120000,
    },
  },
  apps: {
    "android.debug": {
      type: "android.apk",
      binaryPath: "android/app/build/outputs/apk/debug/app-debug.apk",
      build: "cd android && gradlew.bat :app:assembleDebug :app:assembleAndroidTest -DtestBuildType=debug",
    },
  },
  devices: {
    emulator: {
      type: "android.emulator",
      device: {
        avdName: process.env.CESIUM_ANDROID_AVD || "OpenCursorPixelApi35",
      },
    },
  },
  configurations: {
    "android.emu.debug": {
      device: "emulator",
      app: "android.debug",
    },
  },
};

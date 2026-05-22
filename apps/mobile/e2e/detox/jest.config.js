module.exports = {
  rootDir: "../..",
  testMatch: ["<rootDir>/e2e/detox/**/*.test.js"],
  globalSetup: "detox/runners/jest/globalSetup",
  globalTeardown: "detox/runners/jest/globalTeardown",
  reporters: ["detox/runners/jest/reporter"],
  testEnvironment: "detox/runners/jest/testEnvironment",
  maxWorkers: 1,
  testTimeout: 180000,
};

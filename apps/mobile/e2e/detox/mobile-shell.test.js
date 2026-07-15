describe("Cesium mobile shell", () => {
  beforeAll(async () => {
    await device.launchApp({
      newInstance: true,
      permissions: {
        notifications: "YES",
      },
      launchArgs: {
        CESIUM_MOBILE_SERVER_URL: "http://10.0.2.2:9100",
      },
    });
  });

  it("launches the native shell without crashing", async () => {
    await expect(element(by.id("cesium-mobile-root"))).toBeVisible();
    await device.takeScreenshot("mobile-native-shell");
  });
});

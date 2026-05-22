describe("Cesium mobile shell", () => {
  beforeAll(async () => {
    await device.launchApp({
      newInstance: true,
      permissions: {
        notifications: "YES",
      },
      launchArgs: {
        CESIUM_MOBILE_WEB_URL: "http://10.0.2.2:5173",
        CESIUM_MOBILE_SERVER_URL: "http://10.0.2.2:9100",
      },
    });
  });

  it("launches the WebView host without crashing", async () => {
    await device.takeScreenshot("mobile-webview-host");
  });
});

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

  it("exposes composer controls for send, attach, model, and mode", async () => {
    await expect(element(by.id("native-chat-composer"))).toBeVisible();
    await expect(element(by.id("native-chat-input"))).toBeVisible();
    await expect(element(by.id("native-chat-send"))).toBeVisible();
    await expect(element(by.id("native-chat-attach"))).toBeVisible();
    await expect(element(by.id("native-chat-model"))).toBeVisible();
    await expect(element(by.id("native-chat-mode"))).toBeVisible();
  });

  it("exposes consent-gated Android control and assistant settings", async () => {
    await element(by.id("open-agent-rail")).tap();
    await expect(element(by.id("agent-workspace-rail"))).toBeVisible();
    await element(by.id("open-native-settings")).tap();
    await expect(element(by.id("native-settings-shell"))).toBeVisible();
    await element(by.id("settings-open-mobile-control")).tap();
    await expect(element(by.id("mobile-control-settings"))).toBeVisible();
    await expect(element(by.id("mobile-control-enabled"))).toBeVisible();
    await expect(element(by.id("mobile-control-accessibility"))).toBeVisible();
    await expect(element(by.id("mobile-control-assistant-role"))).toBeVisible();
  });
});

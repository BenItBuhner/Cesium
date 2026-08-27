import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildMobileBootstrapScript,
  encodeMobileBridgeMessage,
  openExternalUrl,
  parseMobileBridgeMessage,
} from "../src/lib/mobile-bridge.ts";
import { createLaunchUrlConfig } from "../apps/mobile/src/services/launchConfig.ts";

describe("mobile bridge", () => {
  test("round-trips typed bridge messages", () => {
    const encoded = encodeMobileBridgeMessage({
      type: "focusedConversationChanged",
      workspaceId: "w1",
      conversationId: "c1",
      lastEventSeq: 42,
    });
    const parsed = parseMobileBridgeMessage<{
      type: string;
      workspaceId: string;
      conversationId: string;
      lastEventSeq: number;
    }>(encoded);
    assert.deepEqual(parsed, {
      type: "focusedConversationChanged",
      workspaceId: "w1",
      conversationId: "c1",
      lastEventSeq: 42,
    });
  });

  test("rejects malformed bridge payloads", () => {
    assert.equal(parseMobileBridgeMessage("{"), null);
    assert.equal(parseMobileBridgeMessage(JSON.stringify({ value: true })), null);
    assert.equal(parseMobileBridgeMessage(null), null);
  });

  test("round-trips multi-agent projection sets and active conversation ids", () => {
    assert.deepEqual(
      parseMobileBridgeMessage(
        encodeMobileBridgeMessage({
          type: "agentProjections",
          projections: [{ conversationId: "c1" }, { conversationId: "c2" }],
        })
      ),
      {
        type: "agentProjections",
        projections: [{ conversationId: "c1" }, { conversationId: "c2" }],
      }
    );
    assert.deepEqual(
      parseMobileBridgeMessage(
        encodeMobileBridgeMessage({
          type: "focusedConversationChanged",
          workspaceId: "w1",
          conversationId: "c1",
          lastEventSeq: 7,
          activeConversationIds: ["c1", "c2"],
        })
      ),
      {
        type: "focusedConversationChanged",
        workspaceId: "w1",
        conversationId: "c1",
        lastEventSeq: 7,
        activeConversationIds: ["c1", "c2"],
      }
    );
  });

  test("round-trips mobile live-activity preference and native status", () => {
    assert.deepEqual(
      parseMobileBridgeMessage(
        encodeMobileBridgeMessage({
          type: "setLiveUpdatePreference",
          preference: "basic",
        })
      ),
      {
        type: "setLiveUpdatePreference",
        preference: "basic",
      }
    );
    assert.deepEqual(
      parseMobileBridgeMessage(
        encodeMobileBridgeMessage({
          type: "mobileNativeStatus",
          status: {
            liveUpdates: {
              preference: "live",
              sdkInt: 36,
              progressStyleSupported: true,
              canPostPromotedNotifications: false,
              notificationPermissionGranted: true,
            },
          },
        })
      ),
      {
        type: "mobileNativeStatus",
        status: {
          liveUpdates: {
            preference: "live",
            sdkInt: 36,
            progressStyleSupported: true,
            canPostPromotedNotifications: false,
            notificationPermissionGranted: true,
          },
        },
      }
    );
    assert.deepEqual(
      parseMobileBridgeMessage(
        encodeMobileBridgeMessage({
          type: "setPhoneControlEnabled",
          enabled: true,
        })
      ),
      {
        type: "setPhoneControlEnabled",
        enabled: true,
      }
    );
  });

  test("bootstrap script embeds sanitized mobile server metadata", () => {
    const script = buildMobileBootstrapScript({
      baseUrl: "http://10.0.2.2:9100/",
      label: "Emulator",
      authToken: "secret",
      safeAreaTop: 24,
      systemColorScheme: "dark",
    });
    assert.match(script, /window\.cesiumMobile/);
    assert.match(script, /http:\/\/10\.0\.2\.2:9100/);
    assert.doesNotMatch(script, /http:\/\/10\.0\.2\.2:9100\//);
    assert.match(script, /nativeReady/);
    assert.match(script, /"safeAreaTop":24/);
    assert.match(script, /"systemColorScheme":"dark"/);
    assert.match(script, /window\.__CESIUM_MOBILE_NATIVE_READY__ = "\{\\"type\\":\\"nativeReady/);
    assert.doesNotMatch(script, /safeAreaTop":44/);
    // Polyfills and first-paint theming live in the bundled workbench now
    // (legacy-webview-polyfills.ts + the asset-copy theme stamp), not in the
    // injected bootstrap - the bootstrap is a minimal preload analog.
    assert.doesNotMatch(script, /applyStartupTheme/);
    assert.doesNotMatch(script, /syncLegacyThemeTokens/);
    assert.doesNotMatch(script, /Array\.prototype\.at/);
    assert.doesNotMatch(script, /structuredClone/);
    assert.match(script, /__CESIUM_MOBILE_EXTERNAL_NAV__/);
    assert.match(script, /openExternalUrl/);
  });

  test("bootstrap script does not invent a minimum safe area", () => {
    const script = buildMobileBootstrapScript({
      baseUrl: "http://10.0.2.2:9100/",
      label: "Emulator",
    });
    assert.match(script, /"safeAreaTop":0/);
    assert.doesNotMatch(script, /--opencursor-mobile-safe-area-top:44px/);
  });

  test("bootstrap script embeds sanitized Android runtime metadata", () => {
    const script = buildMobileBootstrapScript({
      baseUrl: "http://127.0.0.1:9100",
      runtime: {
        projectsDir: "/data/user/0/com.cesium.mobile/files/projects",
        serverDataDir: "/data/user/0/com.cesium.mobile/files/server-data",
        defaultWorkspaceRoot: "/data/user/0/com.cesium.mobile/files/projects/default",
        allowedWorkspaceRoots: [
          "/data/user/0/com.cesium.mobile/files/projects",
          "",
        ],
        backendEnvironment: {
          OPENCURSOR_DATA_DIR: "/data/user/0/com.cesium.mobile/files/server-data",
          OPENCURSOR_STORAGE_DRIVER: "legacy-json",
          WORKSPACE_ALLOWED_ROOTS: "/data/user/0/com.cesium.mobile/files/projects",
          EMPTY_VALUE_IS_DROPPED: "",
        },
        localBackendReady: false,
      },
    });

    assert.match(script, /"projectsDir":"\/data\/user\/0\/com\.cesium\.mobile\/files\/projects"/);
    assert.match(script, /"OPENCURSOR_STORAGE_DRIVER":"legacy-json"/);
    assert.match(script, /"localBackendReady":false/);
    assert.doesNotMatch(script, /EMPTY_VALUE_IS_DROPPED/);
  });

  test("launch config keeps globals authoritative while carrying runtime paths", () => {
    const config = createLaunchUrlConfig(
      {
        defaultServerUrl: "http://10.0.2.2:9100",
        globals: {
          CESIUM_MOBILE_SERVER_URL: " http://localhost:9100 ",
        },
      },
      {
        projectsDir: "/files/projects",
        serverDataDir: "/files/server-data",
        defaultWorkspaceRoot: "/files/projects/default",
        allowedWorkspaceRoots: ["/files/projects"],
        backendEnvironment: {
          WORKSPACE_ROOT: "/files/projects/default",
        },
        localBackendReady: false,
      }
    );

    assert.equal(config.serverUrl, "http://localhost:9100");
    assert.equal(config.runtime?.defaultWorkspaceRoot, "/files/projects/default");
  });

  test("openExternalUrl posts to the native bridge instead of window.open", () => {
    const posted: unknown[] = [];
    const g = globalThis as typeof globalThis & { window?: unknown };
    const previous = g.window;
    g.window = {
      ReactNativeWebView: {
        postMessage(message: string) {
          posted.push(JSON.parse(message));
        },
      },
      open() {
        assert.fail("window.open must not run when the native bridge is present");
      },
    };
    try {
      assert.equal(openExternalUrl("https://auth.openai.com/oauth/authorize"), true);
      assert.deepEqual(posted, [
        { type: "openExternalUrl", url: "https://auth.openai.com/oauth/authorize" },
      ]);
    } finally {
      g.window = previous;
    }
  });
});

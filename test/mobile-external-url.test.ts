import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import test from "node:test";
import {
  isMobileExternalHttpUrl,
  mobileExternalHttpUrl,
  shouldOpenMobileNavigationExternally,
} from "../packages/core/src/mobile-external-url.ts";
import { buildMobileBootstrapScript } from "../packages/core/src/mobile-bridge.ts";

const FILE_WORKBENCH = "file:///android_asset/workbench/index.html";
const HOSTED_WORKBENCH = "http://10.0.2.2:3000/agent";
const OAUTH_URL =
  "https://auth.openai.com/oauth/authorize?client_id=cesium&redirect_uri=http://10.0.2.2:9100/api/settings/pi-agent/oauth/callback";

test("file:// workbench treats every http(s) URL as foreign", () => {
  assert.equal(isMobileExternalHttpUrl(OAUTH_URL, FILE_WORKBENCH), true);
  assert.equal(
    isMobileExternalHttpUrl("http://localhost:1455/auth/device", FILE_WORKBENCH),
    true
  );
  assert.equal(isMobileExternalHttpUrl(FILE_WORKBENCH, FILE_WORKBENCH), false);
  assert.equal(
    isMobileExternalHttpUrl(`${FILE_WORKBENCH}?window=2`, FILE_WORKBENCH),
    false
  );
});

test("hosted workbench only treats a different origin as foreign", () => {
  assert.equal(isMobileExternalHttpUrl(OAUTH_URL, HOSTED_WORKBENCH), true);
  assert.equal(
    isMobileExternalHttpUrl("http://10.0.2.2:3000/settings", HOSTED_WORKBENCH),
    false
  );
  assert.equal(isMobileExternalHttpUrl(HOSTED_WORKBENCH, HOSTED_WORKBENCH), false);
});

test("non-http schemes never go to the system browser", () => {
  assert.equal(mobileExternalHttpUrl("javascript:alert(1)"), null);
  assert.equal(mobileExternalHttpUrl("file:///android_asset/workbench/index.html"), null);
  assert.equal(mobileExternalHttpUrl("about:blank"), null);
  assert.equal(mobileExternalHttpUrl(""), null);
  assert.equal(mobileExternalHttpUrl(OAUTH_URL), OAUTH_URL);
});

test("iframe navigations stay inside the WebView", () => {
  assert.equal(
    shouldOpenMobileNavigationExternally(OAUTH_URL, {
      documentUrl: FILE_WORKBENCH,
      isTopFrame: false,
    }),
    false
  );
  assert.equal(
    shouldOpenMobileNavigationExternally(OAUTH_URL, {
      documentUrl: FILE_WORKBENCH,
      isTopFrame: true,
    }),
    true
  );
});

test("bootstrap script intercepts window.open and target=_blank for foreign http(s)", () => {
  const script = buildMobileBootstrapScript({
    baseUrl: "http://10.0.2.2:9100",
  });
  assert.match(script, /__CESIUM_MOBILE_EXTERNAL_NAV__/);
  assert.match(script, /type: "openExternalUrl"/);
  assert.match(script, /patchedOpen/);
  assert.match(script, /window\.open/);
  assert.match(script, /a\[href\]/);
});

test("injected bootstrap sends OAuth window.open to the native shell", () => {
  const posted: unknown[] = [];
  const clickListeners: Array<(event: object) => void> = [];
  const windowMock: Record<string, unknown> = {
    location: {
      protocol: "file:",
      href: FILE_WORKBENCH,
      origin: "null",
      pathname: "/android_asset/workbench/index.html",
    },
    history: {
      pushState() {},
      replaceState() {},
    },
    ReactNativeWebView: {
      postMessage(message: string) {
        posted.push(JSON.parse(message));
      },
    },
    document: {
      documentElement: {
        classList: { add() {} },
        style: { setProperty() {} },
      },
      addEventListener(type: string, listener: (event: object) => void) {
        if (type === "click") {
          clickListeners.push(listener);
        }
      },
    },
    addEventListener() {},
    dispatchEvent() {},
    open(url: string) {
      return { href: url, fromOriginal: true };
    },
  };
  const context = createContext({
    window: windowMock,
    document: windowMock.document,
    URL,
    Object,
  });
  runInContext(scriptFromBootstrap(), context);
  const opened = (windowMock.open as (url: string) => { fromOriginal?: boolean }).call(
    windowMock,
    OAUTH_URL
  );
  assert.equal(opened.fromOriginal, undefined);
  assert.deepEqual(posted, [{ type: "openExternalUrl", url: OAUTH_URL }]);

  posted.length = 0;
  const sameOrigin = (windowMock.open as (url: string) => { fromOriginal?: boolean }).call(
    windowMock,
    `${FILE_WORKBENCH}?window=2`
  );
  assert.equal(sameOrigin.fromOriginal, true);
  assert.deepEqual(posted, []);

  clickListeners[0]?.({
    target: {
      closest() {
        return {
          getAttribute(name: string) {
            return name === "href" ? OAUTH_URL : "";
          },
          href: OAUTH_URL,
        };
      },
    },
    preventDefault() {},
    stopPropagation() {},
  });
  assert.deepEqual(posted, [{ type: "openExternalUrl", url: OAUTH_URL }]);

  function scriptFromBootstrap() {
    return buildMobileBootstrapScript({ baseUrl: "http://10.0.2.2:9100" });
  }
});

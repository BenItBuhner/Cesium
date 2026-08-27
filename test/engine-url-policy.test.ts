import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  assertEngineConnectionAllowed,
  assertEngineServerUrlAllowed,
  CESIUM_ACCOUNT_SITE_NOT_A_SERVER_MESSAGE,
  isCesiumAccountSiteUrl,
  isLoopbackEngineUrl,
  REMOTE_ENGINE_AUTH_REQUIRED_MESSAGE,
} from "../packages/client/src/engine-url-policy.ts";

describe("engine URL policy", () => {
  test("loopback URLs do not require auth to connect", () => {
    assert.equal(isLoopbackEngineUrl("http://localhost:9100"), true);
    assert.equal(isLoopbackEngineUrl("http://127.0.0.1:9100"), true);
    assert.equal(isLoopbackEngineUrl("http://10.0.2.2:9100"), true);
    assert.doesNotThrow(() =>
      assertEngineConnectionAllowed({
        baseUrl: "http://localhost:9100",
        authEnabled: false,
      })
    );
  });

  test("remote URLs require engine auth - a pasted host is not enough", () => {
    assert.equal(isLoopbackEngineUrl("https://engine.example"), false);
    assert.throws(
      () =>
        assertEngineConnectionAllowed({
          baseUrl: "https://engine.example",
          authEnabled: false,
        }),
      (error: unknown) =>
        error instanceof Error && error.message === REMOTE_ENGINE_AUTH_REQUIRED_MESSAGE
    );
    assert.throws(
      () =>
        assertEngineConnectionAllowed({
          baseUrl: "https://engine.example",
          authEnabled: null,
        }),
      /will not connect/
    );
    assert.doesNotThrow(() =>
      assertEngineConnectionAllowed({
        baseUrl: "https://engine.example",
        authEnabled: true,
      })
    );
  });

  test("the Cesium account site is never a valid engine", () => {
    assert.equal(isCesiumAccountSiteUrl("https://cesium.techlitnow.com"), true);
    assert.equal(isCesiumAccountSiteUrl("https://www.cesium.techlitnow.com/"), true);
    assert.equal(isCesiumAccountSiteUrl("https://engine.example"), false);
    assert.throws(
      () => assertEngineServerUrlAllowed("https://cesium.techlitnow.com"),
      (error: unknown) =>
        error instanceof Error && error.message === CESIUM_ACCOUNT_SITE_NOT_A_SERVER_MESSAGE
    );
    assert.throws(
      () =>
        assertEngineConnectionAllowed({
          baseUrl: "https://cesium.techlitnow.com",
          authEnabled: true,
        }),
      /account site/
    );
  });
});

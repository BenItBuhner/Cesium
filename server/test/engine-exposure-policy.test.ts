import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  assertEngineExposureAllowed,
  ENGINE_EXPOSURE_AUTH_REQUIRED_MESSAGE,
  isLoopbackControlRequest,
} from "../src/lib/engine-exposure-policy.ts";

describe("engine exposure policy", () => {
  test("loopback bind without auth is allowed", () => {
    assert.doesNotThrow(() =>
      assertEngineExposureAllowed({
        bindHost: "127.0.0.1",
        authEnabled: false,
      })
    );
  });

  test("non-loopback bind without auth is refused", () => {
    assert.throws(
      () =>
        assertEngineExposureAllowed({
          bindHost: "0.0.0.0",
          authEnabled: false,
        }),
      (error: unknown) =>
        error instanceof Error && error.message === ENGINE_EXPOSURE_AUTH_REQUIRED_MESSAGE
    );
    assert.doesNotThrow(() =>
      assertEngineExposureAllowed({
        bindHost: "0.0.0.0",
        authEnabled: true,
      })
    );
  });

  test("public access or a custom URL without auth is refused", () => {
    assert.throws(
      () =>
        assertEngineExposureAllowed({
          bindHost: "127.0.0.1",
          authEnabled: false,
          publicAccessEnabled: true,
        }),
      /refuses to expose/
    );
    assert.throws(
      () =>
        assertEngineExposureAllowed({
          bindHost: "127.0.0.1",
          authEnabled: false,
          customPublicUrl: "https://totally-fine.example",
        }),
      /refuses to expose/
    );
  });

  test("public-access control is loopback-only until auth exists", () => {
    assert.equal(isLoopbackControlRequest("http://127.0.0.1:9100/api/public-access/enable"), true);
    assert.equal(isLoopbackControlRequest("http://localhost:9100/api/public-access/enable"), true);
    assert.equal(
      isLoopbackControlRequest("https://fresh-public.lhr.life/api/public-access/enable"),
      false
    );
  });
});

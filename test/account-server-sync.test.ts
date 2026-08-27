import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  accountOwnsServers,
  shouldOfferManualServerConnect,
  shouldShowServerUrlInDevicePicker,
} from "../src/lib/account-server-sync.ts";

describe("account server sync UI gates", () => {
  test("a signed-in production account owns servers automatically", () => {
    const clerkReady = { mode: "clerk", status: "ready" };
    const deviceReady = { mode: "device", status: "ready" };
    assert.equal(accountOwnsServers(clerkReady), true);
    assert.equal(accountOwnsServers(deviceReady), true);
    assert.equal(shouldOfferManualServerConnect(clerkReady), false);
    assert.equal(shouldOfferManualServerConnect(deviceReady), false);
    assert.equal(
      shouldShowServerUrlInDevicePicker({ cloud: clerkReady, isLocalDevice: false }),
      false
    );
    assert.equal(
      shouldShowServerUrlInDevicePicker({ cloud: clerkReady, isLocalDevice: true }),
      true
    );
  });

  test("local-only and signed-out clients keep the URL fallback", () => {
    const local = { mode: "disabled", status: "disabled" };
    const signedOut = { mode: "clerk", status: "signed-out" };
    const loading = { mode: "clerk", status: "loading" };
    assert.equal(shouldOfferManualServerConnect(local), true);
    assert.equal(shouldOfferManualServerConnect(signedOut), true);
    assert.equal(shouldOfferManualServerConnect(loading), true);
    assert.equal(
      shouldShowServerUrlInDevicePicker({ cloud: local, isLocalDevice: false }),
      true
    );
    assert.equal(
      shouldShowServerUrlInDevicePicker({ cloud: signedOut, isLocalDevice: false }),
      true
    );
  });
});

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  createMemoryKeyValueStore,
  getClientPlatform,
  setClientPlatform,
} from "../packages/client/src/index.ts";
import { isSecretEnvelope } from "../packages/core/src/secret-envelope.ts";
import {
  buildEngineConnectUrl,
  claimEnginePairing,
  engineAuthSecretKind,
  findEngineCredentialPayload,
  getPendingEngineConnect,
  isEnginePairingCode,
  openEngineCredential,
  parseEngineAuthSecretKind,
  parseEngineConnectInput,
  sealEngineCredential,
  setPendingEngineConnect,
} from "../src/lib/cloud/engine-pairing.ts";
import { landingConnectForwardTarget } from "../src/components/landing/LandingConnectForwarder.tsx";
import {
  clerkAuthRedirectPath,
  resumableClerkRedirectPath,
} from "../src/lib/cloud/clerk-native-handoff.ts";

const originalPlatform = getClientPlatform();
const CODE = "pbuuqg3u9cz3k4z65rb7ufuyse";
const SERVER_ID = "7agm8FI3q8b6UH6FwKo_zX2PVUe7ND8x";

function useMemoryStore() {
  const store = createMemoryKeyValueStore();
  setClientPlatform({
    ...originalPlatform,
    keyValueStore: store,
    emitEvent: () => undefined,
    addEventListener: () => () => undefined,
  });
  return store;
}

afterEach(() => {
  setClientPlatform(originalPlatform);
});

describe("engine pairing: codes and links", () => {
  test("codes are lowercase url-safe and links live under /connect", () => {
    assert.equal(isEnginePairingCode(CODE), true);
    assert.equal(isEnginePairingCode(CODE.toUpperCase()), true);
    assert.equal(isEnginePairingCode("short"), false);
    assert.equal(isEnginePairingCode("has-dash-in-it-which-is-not-ok"), false);
    assert.equal(
      buildEngineConnectUrl("https://cesium.techlitnow.com/", CODE),
      `https://cesium.techlitnow.com/connect/${CODE}`
    );
  });

  test("secret kinds are keyed by rendezvous server id", () => {
    const kind = engineAuthSecretKind(SERVER_ID);
    assert.equal(kind, `engine.auth.${SERVER_ID}`);
    assert.equal(parseEngineAuthSecretKind(kind), SERVER_ID);
    assert.equal(parseEngineAuthSecretKind("engine.auth.short"), null);
    assert.equal(parseEngineAuthSecretKind("harness.auth.codex"), null);
    assert.equal(
      findEngineCredentialPayload(
        [
          { kind: "wrapping-key", payload: "k" },
          { kind, payload: "sealed" },
        ],
        SERVER_ID
      ),
      "sealed"
    );
    assert.equal(findEngineCredentialPayload([], SERVER_ID), null);
  });
});

describe("engine pairing: sealed credential", () => {
  test("seals with the account wrapping key and opens back on the same account", async () => {
    useMemoryStore();
    const sealed = await sealEngineCredential({
      serverId: SERVER_ID,
      username: "cesium",
      password: "p4ss-w0rd",
    });
    assert.equal(isSecretEnvelope(sealed), true);
    assert.doesNotMatch(sealed, /p4ss-w0rd/);
    const opened = await openEngineCredential(sealed, SERVER_ID);
    assert.deepEqual(opened, {
      version: 1,
      serverId: SERVER_ID,
      username: "cesium",
      password: "p4ss-w0rd",
    });
    // Purpose binding: the same envelope cannot be replayed for another engine.
    assert.equal(await openEngineCredential(sealed, "zyxwvutsrqponmlkjihgfedcba"), null);
  });

  test("a device without the wrapping key cannot open the credential", async () => {
    useMemoryStore();
    const sealed = await sealEngineCredential({
      serverId: SERVER_ID,
      username: "cesium",
      password: "secret",
    });
    useMemoryStore();
    assert.equal(await openEngineCredential(sealed, SERVER_ID), null);
  });
});

describe("engine pairing: pending code across sign-in", () => {
  test("round-trips and expires", () => {
    useMemoryStore();
    assert.equal(getPendingEngineConnect(), null);
    setPendingEngineConnect(CODE.toUpperCase());
    assert.equal(getPendingEngineConnect(), CODE);
    assert.equal(getPendingEngineConnect(Date.now() + 31 * 60_000), null);
    setPendingEngineConnect(CODE);
    setPendingEngineConnect(null);
    assert.equal(getPendingEngineConnect(), null);
    setPendingEngineConnect("nope");
    assert.equal(getPendingEngineConnect(), null);
  });
});

describe("engine pairing: claim", () => {
  test("posts the code to the engine and validates the bundle", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({
        serverId: SERVER_ID,
        label: "bennett-box",
        fingerprint: "7945-06CC-202F",
        publicUrl: "https://bennett-box.lhr.life:9443/",
        rendezvous: {
          version: 1,
          serverId: SERVER_ID,
          secret: "s".repeat(43),
          registryBaseUrl: "https://cesium.techlitnow.com",
        },
        auth: { username: "cesium", password: "pw" },
      });
    }) as typeof fetch;
    const claim = await claimEnginePairing({
      publicUrl: "https://bennett-box.lhr.life:9443",
      code: CODE,
      account: { email: "bennett@example.com" },
      fetchImpl,
    });
    assert.equal(calls[0]?.url, "https://bennett-box.lhr.life:9443/api/pairing/claim");
    assert.deepEqual(calls[0]?.body, {
      code: CODE,
      account: { email: "bennett@example.com", name: null },
    });
    assert.equal(claim.publicUrl, "https://bennett-box.lhr.life:9443");
    assert.equal(claim.label, "bennett-box");
    assert.equal(claim.rendezvous.serverId, SERVER_ID);
    assert.equal(claim.auth.password, "pw");
  });

  test("surfaces the engine's error and a reachability hint", async () => {
    await assert.rejects(
      claimEnginePairing({
        publicUrl: "https://bennett-box.lhr.life:9443",
        code: CODE,
        fetchImpl: (async () =>
          Response.json({ error: "This connect link was already used." }, { status: 409 })) as typeof fetch,
      }),
      /already used/
    );
    await assert.rejects(
      claimEnginePairing({
        publicUrl: "https://bennett-box.lhr.life:9443",
        code: CODE,
        fetchImpl: (async () => {
          throw new TypeError("Failed to fetch");
        }) as typeof fetch,
      }),
      /Could not reach the engine at bennett-box\.lhr\.life:9443/
    );
    await assert.rejects(
      claimEnginePairing({
        publicUrl: "https://bennett-box.lhr.life:9443",
        code: CODE,
        fetchImpl: (async () =>
          Response.json({
            serverId: SERVER_ID,
            publicUrl: "https://bennett-box.lhr.life:9443",
            fingerprint: "7945-06CC-202F",
            rendezvous: {
              version: 1,
              serverId: "zyxwvutsrqponmlkjihgfedcba",
              secret: "s".repeat(43),
              registryBaseUrl: "https://cesium.techlitnow.com",
            },
            auth: { username: "cesium", password: "pw" },
          })) as typeof fetch,
      }),
      /identity did not match/
    );
  });
});

describe("engine pairing: pasted input", () => {
  test("recognizes bare engine URLs, legacy connect links, and pairing links", () => {
    assert.deepEqual(parseEngineConnectInput("https://bennett-box.lhr.life:9443/"), {
      kind: "engine-url",
      baseUrl: "https://bennett-box.lhr.life:9443",
    });
    assert.deepEqual(
      parseEngineConnectInput(
        "https://cesium.techlitnow.com/agent?serverUrl=https%3A%2F%2Fbennett-box.lhr.life%3A9443"
      ),
      { kind: "engine-url", baseUrl: "https://bennett-box.lhr.life:9443" }
    );
    assert.deepEqual(
      parseEngineConnectInput("https://cesium.techlitnow.com?serverUrl=https%3A%2F%2Fx.lhr.life"),
      { kind: "engine-url", baseUrl: "https://x.lhr.life" }
    );
    assert.deepEqual(parseEngineConnectInput(`https://cesium.techlitnow.com/connect/${CODE}`), {
      kind: "pairing-link",
      code: CODE,
      url: `https://cesium.techlitnow.com/connect/${CODE}`,
    });
    assert.deepEqual(parseEngineConnectInput(CODE), { kind: "pairing-link", code: CODE, url: "" });
    assert.equal(parseEngineConnectInput("").kind, "invalid");
    assert.equal(parseEngineConnectInput("ftp://x").kind, "invalid");
  });

  test("decodes the stable connect fragment into URL + locator", () => {
    const fragment = Buffer.from(
      JSON.stringify({
        version: 1,
        serverId: SERVER_ID,
        secret: "s".repeat(43),
        registryBaseUrl: "https://cesium.techlitnow.com",
        initialBaseUrl: "https://bennett-box.lhr.life:9443",
        label: "bennett-box",
      })
    ).toString("base64url");
    const parsed = parseEngineConnectInput(
      `https://cesium.techlitnow.com/agent#cesiumConnect=${fragment}`
    );
    assert.equal(parsed.kind, "engine-url");
    if (parsed.kind === "engine-url") {
      assert.equal(parsed.baseUrl, "https://bennett-box.lhr.life:9443");
      assert.equal(parsed.rendezvous?.serverId, SERVER_ID);
      assert.equal(parsed.label, "bennett-box");
    }
  });
});

describe("legacy connect links reach the workbench", () => {
  test("landing page forwards ?serverUrl= and #cesiumConnect= to /agent", () => {
    assert.equal(
      landingConnectForwardTarget({
        search: "?serverUrl=https%3A%2F%2Fx.lhr.life",
        hash: "",
      }),
      "/agent?serverUrl=https%3A%2F%2Fx.lhr.life"
    );
    assert.equal(
      landingConnectForwardTarget({ search: "", hash: "#cesiumConnect=abc&cesiumSession=t" }),
      "/agent#cesiumConnect=abc&cesiumSession=t"
    );
    assert.equal(landingConnectForwardTarget({ search: "?utm=1", hash: "#hero" }), null);
    assert.equal(landingConnectForwardTarget({ search: "", hash: "" }), null);
  });

  test("sign-in resumes only at a pairing approval page", () => {
    assert.equal(resumableClerkRedirectPath(`/connect/${CODE}`), `/connect/${CODE}`);
    assert.equal(resumableClerkRedirectPath("/agent"), null);
    assert.equal(resumableClerkRedirectPath("https://evil.example/connect/" + CODE), null);
    assert.equal(resumableClerkRedirectPath("//evil.example/connect/" + CODE), null);
    assert.equal(
      clerkAuthRedirectPath({ redirect_url: `/connect/${CODE}` }),
      `/connect/${CODE}`
    );
    assert.equal(clerkAuthRedirectPath({ redirect_url: "/settings" }), "/setup?resume=1");
    assert.equal(
      clerkAuthRedirectPath({ redirect_url: `/connect/${CODE}`, native_handoff: "1" }),
      "/auth/native-return"
    );
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  isSecretEnvelope,
  openSecret,
  sealSecret,
  secretLastFour,
} from "../packages/core/src/secret-envelope.ts";
import { openSecretSync, sealSecretSync } from "../server/src/lib/secret-envelope-node.ts";

describe("secret envelope", () => {
  test("seals and opens with matching purpose", async () => {
    const envelope = await sealSecret("sk-live-super-secret", "wrap-key", "voice.transcription.apiKey");
    assert.equal(isSecretEnvelope(envelope), true);
    assert.equal(envelope.includes("sk-live-super-secret"), false);
    assert.equal(
      await openSecret(envelope, "wrap-key", "voice.transcription.apiKey"),
      "sk-live-super-secret"
    );
  });

  test("refuses a swapped purpose or wrapping key", async () => {
    const envelope = await sealSecret("sk-live-super-secret", "wrap-key", "voice.transcription.apiKey");
    assert.equal(await openSecret(envelope, "wrap-key", "voice.tts.apiKey"), null);
    assert.equal(
      await openSecret(envelope, "wrong-key", "voice.transcription.apiKey"),
      null
    );
  });

  test("node sync helpers interoperate with web crypto", async () => {
    const fromNode = sealSecretSync("http-secret-key", "machine-secret", "voice.transcription.apiKey");
    assert.equal(
      await openSecret(fromNode, "machine-secret", "voice.transcription.apiKey"),
      "http-secret-key"
    );
    const fromWeb = await sealSecret("http-secret-key", "machine-secret", "voice.controller.apiKey");
    assert.equal(
      openSecretSync(fromWeb, "machine-secret", "voice.controller.apiKey"),
      "http-secret-key"
    );
  });

  test("reports last four without exposing the rest", () => {
    assert.equal(secretLastFour("abcd1234"), "1234");
    assert.equal(secretLastFour("   "), undefined);
  });
});

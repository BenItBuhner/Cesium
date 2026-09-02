import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildShareInviteLink,
  buildShareInviteMailto,
  extractShareInviteCode,
  SHARE_INVITE_FRAGMENT_KEY,
} from "../src/lib/cloud/share-invites.ts";

const CODE = "aB3dEfGhIjKlMnOpQrStUvWx";

describe("server share invite links", () => {
  test("builds a fragment-based invite link", () => {
    assert.equal(
      buildShareInviteLink("https://cesium.example.com/", CODE),
      `https://cesium.example.com/#${SHARE_INVITE_FRAGMENT_KEY}=${CODE}`
    );
  });

  test("extracts the code from a full link, a fragment, or a bare code", () => {
    const link = buildShareInviteLink("http://localhost:3000", CODE);
    assert.equal(extractShareInviteCode(link), CODE);
    assert.equal(
      extractShareInviteCode(`#${SHARE_INVITE_FRAGMENT_KEY}=${CODE}`),
      CODE
    );
    assert.equal(extractShareInviteCode(`  ${CODE}  `), CODE);
  });

  test("rejects garbage and short codes", () => {
    assert.equal(extractShareInviteCode(""), null);
    assert.equal(extractShareInviteCode("not a code"), null);
    assert.equal(extractShareInviteCode("short"), null);
    assert.equal(
      extractShareInviteCode(`#${SHARE_INVITE_FRAGMENT_KEY}=bad!code`),
      null
    );
  });

  test("mailto carries the invite link and server name", () => {
    const mailto = buildShareInviteMailto({
      email: "friend@example.com",
      serverName: "Grok Bot Machine",
      inviteLink: buildShareInviteLink("https://cesium.example.com", CODE),
      ownerName: "Owner",
    });
    assert.ok(mailto.startsWith("mailto:friend%40example.com?"));
    assert.ok(mailto.includes(encodeURIComponent("Grok Bot Machine")));
    assert.ok(mailto.includes(encodeURIComponent(CODE)));
  });
});

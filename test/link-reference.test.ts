import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeBrowserProxyHref } from "../src/lib/browser-proxy-url";
import {
  buildLinkMarkdown,
  findComposerLinkReferenceTokens,
  makeComposerLinkReferenceToken,
  splitContentByMarkdownLinks,
  tryParsePastedLinkUrl,
  type LinkReference,
} from "../src/lib/link-reference";

test("link reference tokens are discoverable in composer text", () => {
  const token = makeComposerLinkReferenceToken("link-1");
  assert.equal(token, "\u27E6link:link-1\u27E7");
  assert.deepEqual(findComposerLinkReferenceTokens(`before ${token} after`), [
    { start: 7, end: 20, linkId: "link-1" },
  ]);
});

test("buildLinkMarkdown emits title + url plaintext for the agent", () => {
  const link: LinkReference = {
    id: "link-1",
    url: "https://www.samsung.com/us/",
    title: "Samsung | Mobile | TV | Home",
  };
  assert.equal(
    buildLinkMarkdown(link),
    "[Samsung | Mobile | TV | Home](https://www.samsung.com/us/)"
  );
});

test("buildLinkMarkdown strips brackets from titles and encodes paren URLs", () => {
  const link: LinkReference = {
    id: "link-2",
    url: "https://example.com/path(1)",
    title: "Hello [world]",
  };
  assert.equal(buildLinkMarkdown(link), "[Hello world](https://example.com/path%281%29)");
});

test("tryParsePastedLinkUrl accepts a bare http(s) paste", () => {
  assert.equal(
    tryParsePastedLinkUrl("  https://www.samsung.com/us/  "),
    "https://www.samsung.com/us/"
  );
  assert.equal(tryParsePastedLinkUrl("samsung.com"), null);
  assert.equal(tryParsePastedLinkUrl("see https://example.com please"), null);
});

test("markdown http links parse into compact user message segments", () => {
  const segments = splitContentByMarkdownLinks(
    "Check [Samsung | Mobile | TV | Home](https://www.samsung.com/us/) please"
  );
  assert.deepEqual(segments, [
    { type: "text", text: "Check " },
    {
      type: "link",
      text: "Samsung | Mobile | TV | Home",
      linkUrl: "https://www.samsung.com/us/",
    },
    { type: "text", text: " please" },
  ]);
});

test("decodeBrowserProxyHref unwraps proxied favicon hrefs from rewritten HTML", () => {
  assert.equal(
    decodeBrowserProxyHref(
      "http://localhost:9100/browser/https/resources.samsung.com/path/Favicon.png",
      "http://localhost:9100"
    ),
    "https://resources.samsung.com/path/Favicon.png"
  );
});

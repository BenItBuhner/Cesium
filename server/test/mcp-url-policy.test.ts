import assert from "node:assert/strict";
import test from "node:test";
import { validateMcpRemoteUrl } from "../src/lib/mcp/url-policy.js";

test("validateMcpRemoteUrl accepts public HTTPS URLs", () => {
  const url = validateMcpRemoteUrl("https://mcp.context7.com/mcp");
  assert.equal(url.hostname, "mcp.context7.com");
});

test("validateMcpRemoteUrl rejects non-HTTPS remote hosts", () => {
  assert.throws(
    () => validateMcpRemoteUrl("http://example.com/mcp"),
    /localhost/
  );
});

test("validateMcpRemoteUrl allows localhost HTTP", () => {
  const url = validateMcpRemoteUrl("http://127.0.0.1:8787/mcp");
  assert.equal(url.hostname, "127.0.0.1");
});

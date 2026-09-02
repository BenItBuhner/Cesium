import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { Hono } from "hono";
import { browserProxyRoutes } from "../src/routes/browser-proxy.js";
import {
  isTunnelInterstitialHost,
  TUNNEL_NAVIGATE_QUERY_PARAM,
} from "../src/lib/tunnel-interstitial.js";

/**
 * GitHub Codespaces / dev-tunnels forwarded hosts intercept GET+text/html
 * document loads with an anti-phishing interstitial whose "Verifying session"
 * step never completes inside an embedded iframe. The proxy therefore accepts
 * POST-shaped document navigations marked with `__ocs_navigate=1` and turns
 * them into plain upstream GETs. These tests exercise that conversion.
 */

type SeenRequest = {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

let upstream: Server;
let upstreamPort = 0;
const seen: SeenRequest[] = [];
/** Behavior toggle for the next upstream response. */
let upstreamMode: "html" | "redirect" = "html";

const app = new Hono();
app.route("/browser", browserProxyRoutes);

before(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (upstreamMode === "redirect") {
        res.statusCode = 302;
        res.setHeader("location", "/landing");
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end("<html><body><a href=\"/next\">next</a></body></html>");
    });
  });
  await new Promise<void>((resolve) => {
    upstream.listen(0, "127.0.0.1", resolve);
  });
  upstreamPort = (upstream.address() as AddressInfo).port;
});

after(async () => {
  await new Promise<void>((resolve) => {
    upstream.close(() => resolve());
  });
});

function proxyPath(extraQuery = ""): string {
  return `http://engine.test/browser/http/127.0.0.1:${upstreamPort}/${extraQuery}`;
}

test("tunnel host detection matches forwarded-port domains only", () => {
  assert.equal(isTunnelInterstitialHost("octo-9100.app.github.dev"), true);
  assert.equal(isTunnelInterstitialHost("octo-9100.app.github.dev:443"), true);
  assert.equal(isTunnelInterstitialHost("abc-3000.usw2.devtunnels.ms"), true);
  assert.equal(isTunnelInterstitialHost("localhost:9100"), false);
  assert.equal(isTunnelInterstitialHost("evilapp.github.dev.example.com"), false);
});

test("plain GET documents proxy through unchanged, guest script stays GET-nav", async () => {
  upstreamMode = "html";
  seen.length = 0;
  const res = await app.request(proxyPath());
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.method, "GET");
  const body = await res.text();
  assert.ok(body.includes("data-cesium-design-guest"));
  assert.ok(body.includes("var POST_NAV = false;"));
});

test("marker POST becomes an upstream GET with form artifacts stripped", async () => {
  upstreamMode = "html";
  seen.length = 0;
  const res = await app.request(
    proxyPath(`?${TUNNEL_NAVIGATE_QUERY_PARAM}=1&__ocs_access=tok-123&q=hello`),
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "null",
        "x-forwarded-host": "octo-9100.app.github.dev",
        "x-forwarded-proto": "https",
      },
      body: "",
    }
  );
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  const request = seen[0]!;
  // The upstream site sees a plain document GET - no POST, no marker, no
  // iframe auth token, no form-submission headers.
  assert.equal(request.method, "GET");
  assert.equal(request.url, "/?q=hello");
  assert.equal(request.headers["content-type"], undefined);
  assert.equal(request.headers.origin, undefined);
  assert.ok(String(request.headers.accept).includes("text/html"));
  assert.equal(request.body, "");
  // Served through a tunneled host, the guest script upgrades in-page
  // document navigations to marker POSTs as well.
  const body = await res.text();
  assert.ok(body.includes("var POST_NAV = true;"));
  assert.ok(body.includes("__ocs_navigate"));
});

test("GET through a tunneled host still flags the guest script for POST navs", async () => {
  upstreamMode = "html";
  seen.length = 0;
  const res = await app.request(proxyPath(), {
    headers: { "x-forwarded-host": "octo-9100.app.github.dev" },
  });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes("var POST_NAV = true;"));
});

test("upstream redirects on marker POSTs bounce via a self-submitting POST form", async () => {
  upstreamMode = "redirect";
  seen.length = 0;
  const res = await app.request(
    proxyPath(`?${TUNNEL_NAVIGATE_QUERY_PARAM}=1&__ocs_access=tok-123`),
    {
      method: "POST",
      headers: {
        "x-forwarded-host": "octo-9100.app.github.dev",
        "x-forwarded-proto": "https",
      },
      body: "",
    }
  );
  // A 3xx would be followed by the browser as a GET (and hit the tunnel
  // interstitial); the proxy answers 200 with a form that re-POSTs.
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes("<form method=\"POST\""));
  assert.ok(body.includes("__ocs_navigate=1"));
  assert.ok(body.includes("__ocs_access=tok-123"));
  assert.ok(body.includes("/landing"));
  assert.ok(body.includes("document.forms[0].submit()"));
});

test("upstream redirects on plain GETs keep the regular Location rewrite", async () => {
  upstreamMode = "redirect";
  seen.length = 0;
  const res = await app.request(proxyPath("?__ocs_access=tok-123"));
  assert.equal(res.status, 302);
  const location = res.headers.get("location") ?? "";
  assert.ok(location.includes("/browser/http/"));
  assert.ok(location.includes("__ocs_access=tok-123"));
});

test("real POSTs without the marker still forward as POSTs", async () => {
  upstreamMode = "html";
  seen.length = 0;
  const res = await app.request(proxyPath(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "field=value",
  });
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.method, "POST");
  assert.equal(seen[0]!.body, "field=value");
});

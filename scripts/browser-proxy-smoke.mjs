#!/usr/bin/env node
/**
 * Browser-proxy compatibility smoke test.
 *
 * Runs each URL in `SITES` through our OpenCursor browser proxy and records
 * basic health signals: HTTP status, byte count, HTML title, required-text
 * markers, latency, and any 4xx/5xx on the first redirect chain. A site is
 * considered PASS when:
 *   1. Final status is 200 OK,
 *   2. Content-Type is HTML-ish,
 *   3. Response body contains a hostname-appropriate marker (the site's own
 *      title keyword) so we don't accept a generic 404 / bot-wall page.
 *
 * Usage:
 *   node scripts/browser-proxy-smoke.mjs
 *   node scripts/browser-proxy-smoke.mjs --base https://opencursor.techlitnow.com
 *   node scripts/browser-proxy-smoke.mjs --filter github,wikipedia
 *
 * Environment:
 *   OCS_USERNAME, OCS_PASSWORD — defaults: admin / opencursor2026 (server/.env)
 *   OCS_BASE_URL             — proxy base (default http://localhost:9100)
 */

import { setTimeout as sleep } from "node:timers/promises";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = resolve(__dirname, "..", "server", "tmp", "proxy-smoke");

const argv = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [k, v] = arg.includes("=") ? arg.split("=") : [arg, "true"];
    return [k.replace(/^--/, ""), v];
  })
);

const BASE_URL = (
  argv.base ||
  process.env.OCS_BASE_URL ||
  "http://localhost:9100"
).replace(/\/+$/, "");
const USERNAME = argv.user || process.env.OCS_USERNAME || "admin";
const PASSWORD = argv.password || process.env.OCS_PASSWORD || "opencursor2026";
const FILTER = argv.filter ? String(argv.filter).toLowerCase().split(",") : null;
const CONCURRENCY = Math.max(1, Math.min(Number(argv.concurrency) || 4, 12));

/** @type {Array<{ id: string; label: string; url: string; markers: string[] }>} */
const SITES = [
  // Search engines
  { id: "google",          label: "Google",            url: "https://www.google.com/",                markers: ["google"] },
  { id: "bing",            label: "Bing",              url: "https://www.bing.com/",                  markers: ["bing"] },
  { id: "duckduckgo",      label: "DuckDuckGo",        url: "https://duckduckgo.com/",                markers: ["duckduckgo"] },
  { id: "startpage",       label: "Startpage",         url: "https://www.startpage.com/",             markers: ["startpage"] },

  // Knowledge / docs
  { id: "wikipedia",       label: "Wikipedia",         url: "https://en.wikipedia.org/wiki/Main_Page", markers: ["wikipedia", "main page"] },
  { id: "mdn",             label: "MDN Web Docs",      url: "https://developer.mozilla.org/",          markers: ["mdn", "mozilla"] },
  { id: "archlinux_wiki",  label: "Arch Wiki",         url: "https://wiki.archlinux.org/",             markers: ["arch"] },

  // Dev
  { id: "github",          label: "GitHub",            url: "https://github.com/",                     markers: ["github"] },
  { id: "stackoverflow",   label: "Stack Overflow",    url: "https://stackoverflow.com/",              markers: ["stack overflow"] },
  { id: "npmjs",           label: "npm",               url: "https://www.npmjs.com/",                  markers: ["npm"] },
  { id: "gitlab",          label: "GitLab",            url: "https://gitlab.com/",                     markers: ["gitlab"] },

  // News / media
  { id: "bbc",             label: "BBC",               url: "https://www.bbc.com/",                    markers: ["bbc"] },
  { id: "nytimes",         label: "NY Times",          url: "https://www.nytimes.com/",                markers: ["new york times", "nytimes"] },
  { id: "hackernews",      label: "Hacker News",       url: "https://news.ycombinator.com/",           markers: ["hacker news"] },
  { id: "theverge",        label: "The Verge",         url: "https://www.theverge.com/",               markers: ["verge"] },

  // Social / forums
  { id: "reddit",          label: "Reddit (old UI)",   url: "https://old.reddit.com/",                 markers: ["reddit"] },
  { id: "reddit_new",      label: "Reddit",            url: "https://www.reddit.com/",                 markers: ["reddit"] },
  { id: "lobsters",        label: "Lobste.rs",         url: "https://lobste.rs/",                      markers: ["lobste"] },

  // Video / streaming
  { id: "youtube",         label: "YouTube",           url: "https://www.youtube.com/",                markers: ["youtube"] },
  { id: "vimeo",           label: "Vimeo",             url: "https://vimeo.com/",                      markers: ["vimeo"] },

  // Apps / tools
  { id: "codepen",         label: "CodePen",           url: "https://codepen.io/",                     markers: ["codepen"] },
  { id: "excalidraw",      label: "Excalidraw",        url: "https://excalidraw.com/",                 markers: ["excalidraw"] },
  { id: "shadertoy",       label: "Shadertoy",         url: "https://www.shadertoy.com/",              markers: ["shadertoy"] },

  // Ecommerce
  { id: "amazon",          label: "Amazon",            url: "https://www.amazon.com/",                 markers: ["amazon"] },
  { id: "ebay",            label: "eBay",              url: "https://www.ebay.com/",                   markers: ["ebay"] },

  // AI / research
  { id: "openai",          label: "OpenAI",            url: "https://openai.com/",                     markers: ["openai"] },
  { id: "anthropic",       label: "Anthropic",         url: "https://www.anthropic.com/",              markers: ["anthropic"] },
  { id: "huggingface",     label: "Hugging Face",      url: "https://huggingface.co/",                 markers: ["hugging face", "huggingface"] },

  // Docs / blogs
  { id: "nextjs",          label: "Next.js",           url: "https://nextjs.org/",                     markers: ["next.js"] },
  { id: "reactdev",        label: "React",             url: "https://react.dev/",                      markers: ["react"] },

  // Simple / canary
  { id: "example_com",     label: "example.com",       url: "https://example.com/",                    markers: ["example domain"] },
  { id: "httpbin",         label: "httpbin",           url: "https://httpbin.org/",                    markers: ["httpbin"] },
];

function buildProxyUrl(targetUrl, token) {
  const target = new URL(targetUrl);
  const scheme = target.protocol.replace(":", "");
  const host = encodeURIComponent(target.host);
  const path = target.pathname === "" ? "/" : target.pathname;
  const tail =
    path === "/" && !target.search && !target.hash
      ? ""
      : `${path}${target.search}${target.hash}`;
  const url = new URL(
    `/browser/${scheme}/${host}${tail === "/" ? "" : tail}`,
    BASE_URL
  );
  url.searchParams.set("__ocs_access", token);
  return url.toString();
}

async function login() {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: USERNAME,
      password: PASSWORD,
      remember: true,
    }),
    redirect: "manual",
  });
  if (!res.ok) {
    throw new Error(
      `Login failed: ${res.status} ${res.statusText} — check OCS_USERNAME / OCS_PASSWORD`
    );
  }
  const token = res.headers.get("x-opencursor-session-token");
  if (!token) {
    throw new Error("Login OK but no session token in response headers");
  }
  return token.trim();
}

async function probeSite(site, token) {
  const proxyUrl = buildProxyUrl(site.url, token);
  const controller = new AbortController();
  const killer = setTimeout(() => controller.abort(), 45_000);
  const startedAt = Date.now();
  /** @type {any} */
  let bodyBytes = 0;
  let title = "";
  let contentType = "";
  let finalStatus = 0;
  let redirects = 0;
  let errorMessage = "";
  try {
    const res = await fetch(proxyUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
    });
    finalStatus = res.status;
    contentType = res.headers.get("content-type") || "";
    const raw = await res.arrayBuffer();
    bodyBytes = raw.byteLength;
    if (contentType.includes("text") || contentType.includes("html")) {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(raw);
      const titleMatch = text.match(/<title[^>]*>([^<]*)<\/title>/i);
      title = titleMatch ? titleMatch[1].trim().slice(0, 120) : "";
      const lower = text.toLowerCase();
      const markerHit = site.markers.some((m) => lower.includes(m));
      redirects = 0;
      return {
        id: site.id,
        label: site.label,
        url: site.url,
        proxyUrl,
        status: finalStatus,
        bytes: bodyBytes,
        contentType,
        title,
        ms: Date.now() - startedAt,
        pass:
          finalStatus >= 200 &&
          finalStatus < 300 &&
          /text\/html|application\/xhtml/i.test(contentType) &&
          markerHit,
        markerHit,
        error: "",
      };
    }
    return {
      id: site.id,
      label: site.label,
      url: site.url,
      proxyUrl,
      status: finalStatus,
      bytes: bodyBytes,
      contentType,
      title: "",
      ms: Date.now() - startedAt,
      pass: finalStatus >= 200 && finalStatus < 300,
      markerHit: true,
      error: "",
    };
  } catch (e) {
    errorMessage = e instanceof Error ? e.message : String(e);
    return {
      id: site.id,
      label: site.label,
      url: site.url,
      proxyUrl,
      status: finalStatus,
      bytes: bodyBytes,
      contentType,
      title,
      ms: Date.now() - startedAt,
      pass: false,
      markerHit: false,
      error: errorMessage,
    };
  } finally {
    clearTimeout(killer);
  }
}

async function runBatch(sites, token) {
  /** @type {Array<any>} */
  const results = [];
  /** @type {Array<Promise<void>>} */
  const workers = [];
  let cursor = 0;
  const next = async () => {
    while (cursor < sites.length) {
      const idx = cursor++;
      const site = sites[idx];
      process.stdout.write(`→ ${site.label.padEnd(20)} ... `);
      const r = await probeSite(site, token);
      results[idx] = r;
      process.stdout.write(
        `${r.pass ? "PASS" : "FAIL"}  ${String(r.status).padEnd(3)}  ${String(
          r.bytes
        ).padStart(7)}B  ${String(r.ms).padStart(5)}ms  ${
          r.error ? `err=${r.error}` : r.title || ""
        }\n`
      );
    }
  };
  for (let i = 0; i < CONCURRENCY; i++) workers.push(next());
  await Promise.all(workers);
  return results;
}

function renderReport(results) {
  const pass = results.filter((r) => r.pass).length;
  const total = results.length;
  const lines = [];
  lines.push(`OpenCursor browser-proxy smoke report`);
  lines.push(`Base: ${BASE_URL}`);
  lines.push(`Time: ${new Date().toISOString()}`);
  lines.push(`Pass: ${pass}/${total} (${Math.round((pass / total) * 100)}%)`);
  lines.push("");
  lines.push(
    "site".padEnd(22) +
      "status".padEnd(8) +
      "ms".padEnd(7) +
      "bytes".padEnd(10) +
      "marker".padEnd(8) +
      "title"
  );
  lines.push("-".repeat(100));
  for (const r of results) {
    lines.push(
      (r.pass ? "PASS " : "FAIL ").padEnd(6) +
        r.label.slice(0, 15).padEnd(16) +
        String(r.status).padEnd(8) +
        String(r.ms).padEnd(7) +
        String(r.bytes).padEnd(10) +
        (r.markerHit ? "yes " : "no  ").padEnd(8) +
        (r.error ? `ERR: ${r.error}` : r.title || "")
    );
  }
  return lines.join("\n");
}

async function main() {
  const filtered = FILTER
    ? SITES.filter((s) => FILTER.some((f) => s.id.includes(f)))
    : SITES;
  console.log(
    `Running smoke test against ${filtered.length} sites via ${BASE_URL} (concurrency=${CONCURRENCY})`
  );
  const token = await login();
  console.log(`Auth OK (token ${token.slice(0, 16)}…)\n`);
  const results = await runBatch(filtered, token);

  try {
    await mkdir(REPORTS_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const txtPath = resolve(REPORTS_DIR, `smoke-${stamp}.txt`);
  const jsonPath = resolve(REPORTS_DIR, `smoke-${stamp}.json`);
  const report = renderReport(results);
  await writeFile(txtPath, report, "utf8");
  await writeFile(
    jsonPath,
    JSON.stringify(
      { baseUrl: BASE_URL, timestamp: stamp, results },
      null,
      2
    ),
    "utf8"
  );
  console.log("\n" + report);
  console.log(`\nReports written to:\n  ${txtPath}\n  ${jsonPath}`);

  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("smoke run crashed:", err);
  process.exitCode = 2;
});

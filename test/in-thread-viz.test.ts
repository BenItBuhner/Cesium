import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IN_THREAD_VIZ_MAX_CHARS,
  buildChartVizSrcdoc,
  buildHtmlVizSrcdoc,
  chartRuntimeUrl,
  inThreadVizTitle,
  isInThreadVizOversized,
  matchInThreadVizLanguage,
  parseChartFenceContent,
  shouldRenderInThreadViz,
} from "../src/lib/in-thread-viz";

test("matchInThreadVizLanguage recognizes html and chart fence tokens", () => {
  assert.equal(matchInThreadVizLanguage("html"), "html");
  assert.equal(matchInThreadVizLanguage("HTM"), "html");
  assert.equal(matchInThreadVizLanguage("html Dashboard"), "html");
  assert.equal(matchInThreadVizLanguage("chart"), "chart");
  assert.equal(matchInThreadVizLanguage("chartjs Q3"), "chart");
  assert.equal(matchInThreadVizLanguage("javascript"), null);
  assert.equal(matchInThreadVizLanguage("mermaid"), null);
  assert.equal(matchInThreadVizLanguage(""), null);
  assert.equal(matchInThreadVizLanguage(undefined), null);
});

test("inThreadVizTitle uses the rest of the fence language as a title", () => {
  assert.equal(inThreadVizTitle("html Sales dashboard", "html"), "Sales dashboard");
  assert.equal(inThreadVizTitle("chart", "chart"), "Chart");
  assert.equal(inThreadVizTitle("html", "html"), "Live canvas");
});

test("parseChartFenceContent accepts a Chart.js object and rejects junk", () => {
  const ok = parseChartFenceContent(`{"type":"bar","data":{"labels":["A"],"datasets":[]}}`);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(JSON.parse(ok.json).type, "bar");
  }
  assert.equal(parseChartFenceContent("").ok, false);
  assert.equal(parseChartFenceContent("[1, 2]").ok, false);
  assert.equal(parseChartFenceContent("not json").ok, false);
});

test("buildHtmlVizSrcdoc wraps fragments and leaves documents alone", () => {
  const wrapped = buildHtmlVizSrcdoc("Demo", "<h1>Hi</h1>");
  assert.match(wrapped, /<!doctype html>/i);
  assert.match(wrapped, /<h1>Hi<\/h1>/);
  assert.match(wrapped, /<title>Demo<\/title>/);

  const full = "<html><body>whole</body></html>";
  assert.equal(buildHtmlVizSrcdoc("X", full), full);
});

test("buildChartVizSrcdoc is responsive and points at the engine Chart.js runtime", () => {
  const html = buildChartVizSrcdoc(
    "Revenue",
    '{"type":"line"}',
    "http://localhost:9100/artifacts/_runtime/chart.umd.js"
  );
  assert.match(html, /chart\.umd\.js/);
  assert.match(html, /maintainAspectRatio/);
  assert.match(html, /width=device-width/);
  assert.match(html, /<title>Revenue<\/title>/);
});

test("chartRuntimeUrl joins the engine base without a double slash", () => {
  assert.equal(
    chartRuntimeUrl("http://localhost:9100/"),
    "http://localhost:9100/artifacts/_runtime/chart.umd.js"
  );
});

test("shouldRenderInThreadViz is streaming-safe until the fence closes", () => {
  assert.equal(shouldRenderInThreadViz(false, "html"), null);
  assert.equal(shouldRenderInThreadViz(true, "html"), "html");
  assert.equal(shouldRenderInThreadViz(true, "javascript"), null);
});

test("isInThreadVizOversized caps huge fences", () => {
  assert.equal(isInThreadVizOversized("ok"), false);
  assert.equal(isInThreadVizOversized("x".repeat(IN_THREAD_VIZ_MAX_CHARS + 1)), true);
});

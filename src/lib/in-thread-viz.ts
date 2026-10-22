/**
 * Ephemeral in-thread visualizations: a closed ```html / ```chart fence in
 * assistant markdown renders as a sandboxed live canvas. Persistent charts
 * and pages still go through artifact tools + [[artifact:<id>]] embeds.
 */

export const IN_THREAD_VIZ_MAX_CHARS = 200_000;

export type InThreadVizKind = "html" | "chart";

export type ChartFenceParse =
  | { ok: true; json: string }
  | { ok: false; error: string };

function firstLanguageToken(language: string | undefined): string {
  return language?.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

/** Live only after the closing fence arrives - partial streamed fences stay as code. */
export function shouldRenderInThreadViz(
  closed: boolean,
  language?: string
): InThreadVizKind | null {
  return closed ? matchInThreadVizLanguage(language) : null;
}

/** First fence token only, so `html Dashboard` and `chart Q3` still match. */
export function matchInThreadVizLanguage(language?: string): InThreadVizKind | null {
  const token = firstLanguageToken(language);
  if (token === "html" || token === "htm") {
    return "html";
  }
  if (token === "chart" || token === "chartjs") {
    return "chart";
  }
  return null;
}

export function inThreadVizTitle(language: string | undefined, kind: InThreadVizKind): string {
  const rest = language?.trim().split(/\s+/).slice(1).join(" ").trim();
  if (rest) {
    return rest;
  }
  return kind === "chart" ? "Chart" : "Live canvas";
}

export function isInThreadVizOversized(content: string): boolean {
  return content.length > IN_THREAD_VIZ_MAX_CHARS;
}

export function parseChartFenceContent(content: string): ChartFenceParse {
  const trimmed = content.trim();
  if (!trimmed) {
    return { ok: false, error: "Chart fence is empty." };
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "Chart fence must be a Chart.js config object." };
    }
    return { ok: true, json: JSON.stringify(parsed) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Chart fence is not valid JSON.",
    };
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isHtmlDocument(html: string): boolean {
  return /<html[\s>]/i.test(html);
}

/** Wrap a fragment the same way persisted html artifacts do. */
export function buildHtmlVizSrcdoc(title: string, html: string): string {
  if (isHtmlDocument(html)) {
    return html;
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 16px; box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.5; }
</style>
</head>
<body>
${html}
</body>
</html>
`;
}

/** Self-contained Chart.js page. Runtime URL is the Cesium engine, not the workbench origin. */
export function buildChartVizSrcdoc(
  title: string,
  chartConfigJson: string,
  chartRuntimeUrl: string
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<script src="${escapeHtml(chartRuntimeUrl)}"></script>
<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; height: 100%; background: transparent; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  #chart-shell { position: absolute; inset: 0; padding: 12px; box-sizing: border-box; }
  #chart-error { display: none; padding: 16px; font-size: 13px; color: #b91c1c; white-space: pre-wrap; }
</style>
</head>
<body>
<div id="chart-shell"><canvas id="chart"></canvas></div>
<pre id="chart-error"></pre>
<script id="chart-config" type="application/json">
${chartConfigJson}
</script>
<script>
(function () {
  try {
    var config = JSON.parse(document.getElementById("chart-config").textContent);
    config.options = config.options || {};
    if (config.options.responsive === undefined) config.options.responsive = true;
    if (config.options.maintainAspectRatio === undefined) config.options.maintainAspectRatio = false;
    new Chart(document.getElementById("chart"), config);
  } catch (error) {
    var el = document.getElementById("chart-error");
    el.style.display = "block";
    el.textContent = "Failed to render chart: " + (error && error.message ? error.message : String(error));
  }
})();
</script>
</body>
</html>
`;
}

export function chartRuntimeUrl(serverBaseUrl: string): string {
  const base = serverBaseUrl.replace(/\/+$/, "");
  return `${base}/artifacts/_runtime/chart.umd.js`;
}

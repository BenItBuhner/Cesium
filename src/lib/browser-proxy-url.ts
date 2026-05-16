/** Build `/browser/{scheme}/{encodedHostPort}{path}` matching the Cesium server proxy. */

/**
 * Recover from an old browser-prompt failure mode where the prompt default
 * (`http://localhost:3000/`) could get *prepended* to the user's intended URL,
 * producing values like:
 *
 *   `http://localhost:3000/https://google.com/`
 *   `https://cesium.techlitnow.com/https://google.com/`
 *
 * Those are syntactically valid outer URLs, so `new URL()` happily accepts
 * them and the browser tab then proxies the WRONG target (our own app with an
 * embedded `https://...` path), which manifests as a blank / broken page.
 *
 * Heuristic: if the raw input contains a *second* absolute URL inside the
 * pathname (or anywhere after the first character), prefer the inner URL.
 * This is intentionally conservative: legitimate URLs very rarely embed a
 * second unencoded `http://` / `https://` literal.
 */
function unwrapNestedAbsoluteUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;

  // Direct string search — catches garbage like `foo https://example.com`.
  const laterScheme = trimmed.slice(1).match(/https?:\/\//i);
  if (laterScheme && laterScheme.index != null) {
    const idx = laterScheme.index + 1;
    const candidate = trimmed.slice(idx);
    if (/^https?:\/\//i.test(candidate)) {
      return candidate;
    }
  }

  // Structured path case — `http://host/https://target/...`
  try {
    const outer = new URL(trimmed);
    const pathish = `${outer.pathname}${outer.search}${outer.hash}`;
    const match = pathish.match(/\/(https?:\/\/.+)$/i);
    if (match?.[1]) {
      return match[1];
    }
    // Nested proxy path — e.g.
    //   `https://www.google.com/browser/https/www.google.com/?gws_rd=ssl`
    // (from a previous run where pages like Google read `location.pathname`
    // back into `pushState` and our encoder re-wrapped it). Rescue the real
    // upstream target from the embedded proxy path so a reload heals the
    // persisted tab state instead of perpetually 404-ing on the upstream.
    const proxyEmbed = outer.pathname.match(
      /^\/browser\/(https?)\/([^/]+)(\/.*)?$/i
    );
    if (proxyEmbed?.[1] && proxyEmbed[2]) {
      const scheme = proxyEmbed[1].toLowerCase();
      const host = decodeURIComponent(proxyEmbed[2]);
      const path = proxyEmbed[3] ?? "/";
      return `${scheme}://${host}${path}${outer.search}${outer.hash}`;
    }
  } catch {
    // Ignore malformed outer URL; the plain string heuristic above is enough.
  }

  return trimmed;
}

export function normalizeBrowserTargetUrl(input: string): URL {
  const trimmed = unwrapNestedAbsoluteUrl(input);
  if (!trimmed) {
    throw new Error("URL is empty");
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return new URL(trimmed);
  }
  return new URL(`http://${trimmed}`);
}

export function buildBrowserProxyPath(target: URL): string {
  const scheme = target.protocol.replace(":", "");
  const hostport = target.host;
  const enc = encodeURIComponent(hostport);
  const path = target.pathname === "" ? "/" : target.pathname;
  const tail =
    path === "/" && !target.search && !target.hash
      ? ""
      : `${path}${target.search}${target.hash}`;
  return `/browser/${scheme}/${enc}${tail === "/" ? "" : tail}`;
}

export function buildBrowserProxyUrl(serverBase: string, target: string | URL): string {
  const u = typeof target === "string" ? normalizeBrowserTargetUrl(target) : target;
  const base = serverBase.replace(/\/+$/, "");
  return `${base}${buildBrowserProxyPath(u)}`;
}

/**
 * GitHub Codespaces port forwarding / Microsoft dev tunnels interpose an
 * anti-phishing interstitial on document loads: any `GET` whose `Accept`
 * header contains `text/html` is answered by the tunnel ingress with a
 * "You are about to access a development port served by a codespace" page,
 * and the post-Continue "Verifying session" step never completes inside an
 * embedded cross-origin iframe (no GitHub cookies, partitioned third-party
 * storage). Per the dev-tunnels contract the interstitial is skipped for
 * non-GET methods, non-HTML Accept headers, and the `X-Tunnel-*` headers -
 * so API fetches and WebSockets pass through, but iframe navigations do not.
 *
 * The browser proxy therefore supports POST-shaped document navigations
 * (marked with {@link TUNNEL_NAVIGATE_QUERY_PARAM}) that are converted to
 * plain GETs before reaching the upstream site, and pages served through a
 * tunneled host get a guest script that performs document navigations via
 * auto-submitted POST forms.
 *
 * Mirrored on the client in `src/lib/browser-engine.ts`.
 */

export const TUNNEL_INTERSTITIAL_HOST_SUFFIXES = [
  ".app.github.dev",
  ".githubpreview.dev",
  ".devtunnels.ms",
] as const;

/**
 * Marker query param: "this POST is really a document GET". Client iframes
 * cannot attach headers, but they can submit a form - the proxy strips the
 * marker (and the form body) and fetches the upstream document with GET.
 */
export const TUNNEL_NAVIGATE_QUERY_PARAM = "__ocs_navigate";

/** Whether requests for `host` arrive through an interstitial-injecting tunnel. */
export function isTunnelInterstitialHost(host: string): boolean {
  const hostname = host.split(":")[0]?.trim().toLowerCase() ?? "";
  if (!hostname) return false;
  return TUNNEL_INTERSTITIAL_HOST_SUFFIXES.some((suffix) =>
    hostname.endsWith(suffix)
  );
}

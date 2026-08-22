export const CESIUM_OAUTH_DONE_SCHEME = "cesium://oauth/done";

export function buildOAuthDoneDeepLink(input: {
  sessionId?: string;
  ok: boolean;
  kind?: string;
}): string {
  const params = new URLSearchParams();
  if (input.sessionId?.trim()) {
    params.set("session", input.sessionId.trim());
  }
  params.set("ok", input.ok ? "1" : "0");
  if (input.kind?.trim()) {
    params.set("kind", input.kind.trim());
  }
  return `${CESIUM_OAUTH_DONE_SCHEME}?${params.toString()}`;
}

export function oauthCompletionHtml(input: {
  title: string;
  heading: string;
  message: string;
  postMessageType: string;
  sessionId?: string;
  kind?: string;
  ok: boolean;
}): string {
  const safeTitle = escapeHtml(input.title);
  const safeHeading = escapeHtml(input.heading);
  const safeMessage = escapeHtml(input.message);
  const deepLink = buildOAuthDoneDeepLink({
    sessionId: input.sessionId,
    ok: input.ok,
    kind: input.kind,
  });
  const payload = JSON.stringify({
    type: input.postMessageType,
    ok: input.ok,
    sessionId: input.sessionId ?? null,
    kind: input.kind ?? null,
  });
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${safeTitle}</title></head><body style="font-family:system-ui;padding:2rem;"><h1>${safeHeading}</h1><p>${safeMessage}</p><p>You can close this window and return to Cesium.</p><script>
(function(){
  var payload=${payload};
  try { if (window.opener) window.opener.postMessage(payload, "*"); } catch (error) {}
  try { if (window.parent && window.parent !== window) window.parent.postMessage(payload, "*"); } catch (error) {}
  try { location.href=${JSON.stringify(deepLink)}; } catch (error) {}
})();
</script></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

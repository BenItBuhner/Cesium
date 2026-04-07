export function buildWorkspaceWindowUrl(
  origin: string,
  workspaceId: string,
  windowId: string
): string {
  const url = new URL("/editor", origin);
  url.searchParams.set("workspaceId", workspaceId);
  url.searchParams.set("windowId", windowId);
  return url.toString();
}

/**
 * Browser-machine-specific git configuration endpoints (GitHub token +
 * commit author). These are extra routes that only exist on the browser
 * machine; the picker UI uses them for credential setup.
 */
import { errorResponse, jsonResponse, type EngineRouter } from "../http";
import type { WorkspaceStore } from "../stores/workspaces";
import { BrowserGit, getStoredGithubToken, setStoredGithubToken } from "./browser-git";

export function registerGitRoutes(
  router: EngineRouter,
  deps: { git: BrowserGit; workspaces: WorkspaceStore }
): void {
  router.get("/api/browser-machine/github-token", async () => {
    const token = await getStoredGithubToken();
    return jsonResponse({
      configured: Boolean(token),
      lastFour: token ? token.slice(-4) : null,
    });
  });

  router.put("/api/browser-machine/github-token", async (request) => {
    const body = await request.json<{ token?: string }>();
    if (!body.token?.trim()) {
      return errorResponse("Expected token");
    }
    await setStoredGithubToken(body.token.trim());
    return jsonResponse({ ok: true, configured: true });
  });

  router.delete("/api/browser-machine/github-token", async () => {
    await setStoredGithubToken(null);
    return jsonResponse({ ok: true, configured: false });
  });

  router.get("/api/browser-machine/git-author", async () =>
    jsonResponse({ author: await deps.git.getAuthor() })
  );

  router.put("/api/browser-machine/git-author", async (request) => {
    const body = await request.json<{ name?: string; email?: string }>();
    if (!body.name?.trim() || !body.email?.trim()) {
      return errorResponse("Expected name and email");
    }
    await deps.git.setAuthor({ name: body.name.trim(), email: body.email.trim() });
    return jsonResponse({ ok: true });
  });
}

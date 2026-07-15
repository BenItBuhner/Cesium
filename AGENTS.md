# AGENTS.md

## Cursor Cloud specific instructions

Cesium is a local-first AI workbench: a **Next.js frontend** (port `3000`) and a
**Bun + Hono backend** (port `9100`). Standard install/run/test commands live in
`README.md` and the `scripts` blocks of `package.json` / `server/package.json`.
Default storage is the file-based `legacy-json` driver, so **no Docker / Postgres /
Redis is required** (those services are optional and not installed here).

Run the two dev servers in separate terminals from the repo root:
- Backend: `npm run dev:server` (Bun runtime, listens on `9100`).
- Frontend: `npm run dev` (Next.js dev, `3000`). Uses `.env.local` (already created
  for local dev with `NEXT_PUBLIC_SERVER_URL=http://localhost:9100` and
  `WORKSPACE_ROOT=/workspace`).

Non-obvious caveats discovered during setup (the startup update script already
handles the first two, but you must repeat them by hand if you re-run installs):

- **`bun` is required for the backend** and lives at `~/.bun/bin` (added to
  `~/.bashrc`). A non-login shell may not have it on `PATH`; export
  `PATH="$HOME/.bun/bin:$PATH"` if `bun` is not found.
- **Remove the self-referential symlink `server/node_modules/cesium`** after any
  `npm install` / `npm install --prefix server`. The server's `"cesium": "file:.."`
  dependency symlinks that path back to the repo root; Next.js dev (Turbopack) then
  panics with an infinite `track_glob` loop ("`server/node_modules/cesium` is a
  symlink that causes an infinite loop") and every page returns HTTP 500. Nothing
  in the server actually imports the `cesium` package, so `rm -f
  server/node_modules/cesium` is safe. If the frontend was already running when the
  symlink reappeared, its next request may 500 until the symlink is gone.
- **Build the shared workspace packages before running/testing the server:**
  `npm run build:packages`. The backend and its tests import `@cesium/core/dist/*`,
  so without a build you get `ERR_MODULE_NOT_FOUND` for `@cesium/core/dist/mcp.js`
  and ~7 server test files fail.
- **Integrated terminal (`node-pty`) does not stream output under Bun.** The
  native module loads, but `onData` never fires under the default Bun runtime, so
  the in-app terminal shows a dead/blank session. `node-pty` works correctly under
  Node, so if you need the terminal feature run the backend with the Node runtime
  instead: `npm run dev:node --prefix server`. All other features (agent chat,
  editor, filesystem, browser) work fine under Bun.
- **Agent backends need external CLIs / API keys** (Cursor, Codex, Claude, Gemini,
  OpenCode) that are not installed. The app still boots and lists them as
  unavailable; sending a chat without a configured backend surfaces a
  "Compilation failed / Provider responded" toast. This is expected, not an
  environment break.

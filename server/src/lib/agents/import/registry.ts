import type { AgentBackendId } from "../types.js";
import type { HarnessImportSource } from "./types.js";
import { createClaudeCodeImportSource } from "./sources/claude-code.js";
import { createCodexImportSource } from "./sources/codex.js";
import { createGeminiImportSource } from "./sources/gemini.js";
import { createOpenCodeImportSource } from "./sources/opencode.js";
import { createPiImportSource } from "./sources/pi.js";

/**
 * Registry of harness import sources. Every non-Cesium backend is enumerated:
 * harnesses with on-disk session storage get a working reader; cloud-only
 * harnesses (sessions live server-side behind their own accounts) are listed
 * with an explicit reason so the UI can grey them out honestly.
 */

const IMPORT_SOURCES: HarnessImportSource[] = [
  createClaudeCodeImportSource(),
  createCodexImportSource(),
  createOpenCodeImportSource(),
  createGeminiImportSource(),
  createPiImportSource(),
];

/** Backends whose sessions exist only in the vendor's cloud. */
export const UNSUPPORTED_IMPORT_BACKENDS: Partial<Record<AgentBackendId, string>> = {
  "cesium-agent": "Cesium Agent conversations are native to Cesium - nothing to import.",
  "cursor-sdk":
    "Cursor agent chats are synced to the Cursor account service; the TypeScript SDK keeps no stable on-disk session store to import from.",
  "cursor-acp":
    "Cursor Agent ACP chats are synced to the Cursor account service; the CLI keeps no stable on-disk session store to import from.",
  "devin-acp":
    "Devin sessions live in Cognition's cloud behind your Devin account - there is no local CLI session storage to import.",
  "grok-build":
    "Grok Build sessions live in xAI's cloud behind your Grok account - there is no local CLI session storage to import.",
};

export function listImportSources(): HarnessImportSource[] {
  return IMPORT_SOURCES;
}

export function getImportSourceForBackend(backendId: AgentBackendId): HarnessImportSource | null {
  for (const source of IMPORT_SOURCES) {
    if (source.backendIds.includes(backendId)) {
      return source;
    }
  }
  return null;
}

/** All backend ids that could appear in the import UI, in stable order. */
export const IMPORTABLE_BACKEND_IDS: AgentBackendId[] = [
  "claude-code-sdk",
  "codex-app-server",
  "opencode-server",
  "google-antigravity-cli",
  "pi-agent",
  "cursor-sdk",
  "cursor-acp",
  "devin-acp",
  "grok-build",
];

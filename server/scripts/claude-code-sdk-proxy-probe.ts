/**
 * Live smoke: Claude Agent SDK `query()` against Anthropic auth + ANTHROPIC_BASE_URL
 * (e.g. OpenAI-compatible / Anthropic-shim proxy). Does not start the OpenCursor HTTP server.
 *
 * Loads repo/server `.env` only where variables are unset (no override), so a key passed
 * from the shell / CI is not clobbered by `.env.local` (unlike `env-bootstrap.js`).
 */
import { config } from "dotenv";
import { query } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, "..");
const repoRoot = path.resolve(serverDir, "..");

config({ path: path.join(repoRoot, ".env") });
config({ path: path.join(repoRoot, ".env.local") });
config({ path: path.join(serverDir, ".env") });
config({ path: path.join(serverDir, ".env.local") });

const model =
  process.env.CLAUDE_PROXY_TEST_MODEL?.trim() ||
  process.env.OPENCURSOR_CLAUDE_CODE_SDK_MODEL?.trim() ||
  "glm-5.1-precision";
const cwd = process.env.CLAUDE_PROXY_TEST_CWD?.trim() || repoRoot;
process.env.ANTHROPIC_BASE_URL ||= process.env.OPENCURSOR_CLAUDE_CODE_SDK_BASE_URL?.trim();
process.env.ANTHROPIC_API_KEY ||= process.env.OPENCURSOR_CLAUDE_CODE_SDK_API_KEY?.trim();
if (
  process.env.OPENCURSOR_CLAUDE_CODE_SDK_BASE_URL?.trim() &&
  process.env.OPENCURSOR_CLAUDE_CODE_SDK_API_KEY?.trim()
) {
  process.env.CLAUDE_CODE_API_BASE_URL ||= process.env.OPENCURSOR_CLAUDE_CODE_SDK_BASE_URL.trim();
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

if (!process.env.ANTHROPIC_API_KEY?.trim() && !process.env.ANTHROPIC_AUTH_TOKEN?.trim()) {
  console.error("claude-code-sdk-proxy-probe: set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN");
  process.exit(2);
}

const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
console.log("claude-code-sdk-proxy-probe:", {
  model,
  cwd,
  baseUrl: baseUrl || "(default api.anthropic.com)",
  anthropicApiKeyLen: process.env.ANTHROPIC_API_KEY?.length ?? 0,
  anthropicAuthTokenLen: process.env.ANTHROPIC_AUTH_TOKEN?.length ?? 0,
});

const abortController = new AbortController();
const stream = query({
  prompt: process.env.CLAUDE_PROXY_TEST_PROMPT?.trim() || "Reply with exactly one word: pong.",
  options: {
    cwd,
    abortController,
    model,
    tools: [],
    permissionMode: "dontAsk",
    includePartialMessages: false,
    maxTurns: 4,
    extraArgs: {
      bare: null,
      "setting-sources": "local",
    },
  },
});

let n = 0;
let authRetryCount = 0;
try {
  for await (const message of stream) {
    n += 1;
    const kind =
      message && typeof message === "object" && "type" in message
        ? String((message as { type: unknown }).type)
        : typeof message;
    const preview = JSON.stringify(message);
    console.log(`#${n} [${kind}]`, preview.length > 500 ? `${preview.slice(0, 500)}…` : preview);

    if (
      message &&
      typeof message === "object" &&
      "type" in message &&
      (message as { type: string }).type === "system" &&
      "subtype" in message &&
      (message as { subtype: string }).subtype === "api_retry"
    ) {
      const err = (message as { error?: string; error_status?: number }).error;
      const status = (message as { error_status?: number }).error_status;
      if (status === 401 || err === "authentication_failed") {
        authRetryCount += 1;
        if (authRetryCount >= 2) {
          console.error(
            "claude-code-sdk-proxy-probe: proxy auth failed repeatedly (401). Aborting early — fix ANTHROPIC_BASE_URL / key on the Model-Proxy side."
          );
          abortController.abort();
          process.exit(3);
        }
      }
    }
  }
  console.log(`claude-code-sdk-proxy-probe: ok, ${n} message(s)`);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("claude-code-sdk-proxy-probe: FAILED:", msg);
  process.exit(1);
}

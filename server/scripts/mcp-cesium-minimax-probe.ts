/**
 * Live smoke: Context7 MCP + Cesium adapter on Nvidia Minimax M2.7.
 *
 * Usage (from repo root):
 *   npm run mcp:probe --prefix server
 *
 * Optional env:
 *   NVAPI_KEY / NVIDIA_API_KEY — stored for probe if not already in DATA_DIR
 *   MCP_PROBE_SKIP_LLM=1 — MCP-only (faster)
 *   MCP_PROBE_MODEL=nvidia/minimaxai/minimax-m2.7
 */
import "../src/env-bootstrap.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCesiumSystemPrompt } from "@cesium/core/mcp";
import { DATA_DIR } from "../src/lib/persistence.js";
import {
  resolveCesiumAuth,
  resolveCesiumModelRuntime,
  upsertCesiumProviderKey,
} from "../src/lib/cesium-agent-settings.js";
import {
  callMcpTool,
  refreshWorkspaceMcpMirror,
  testMcpServer,
} from "../src/lib/mcp/connection-manager.js";
import { getMcpPreset } from "../src/lib/mcp/presets.js";
import { upsertMcpServer } from "../src/lib/mcp/server-store.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
const MODEL_ID =
  process.env.MCP_PROBE_MODEL?.trim() || "nvidia/minimaxai/minimax-m2.7";
const WORKSPACE_ID = "mcp-minimax-probe";
const WORKSPACE_ROOT =
  process.env.MCP_PROBE_WORKSPACE?.trim() ||
  process.env.WORKSPACE_ROOT?.trim() ||
  repoRoot;

function log(step: string, detail?: string): void {
  const line = detail ? `[mcp-probe] ${step}: ${detail}` : `[mcp-probe] ${step}`;
  console.log(line);
}

function modelPart(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash >= 0 ? modelId.slice(slash + 1) : modelId;
}

async function ensureProbeWorkspace(): Promise<void> {
  await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
}

async function maybeStoreNvidiaKey(): Promise<void> {
  const apiKey =
    process.env.NVAPI_KEY?.trim() ||
    process.env.NVIDIA_API_KEY?.trim() ||
    "";
  if (!apiKey) {
    return;
  }
  await upsertCesiumProviderKey({
    providerId: "nvidia",
    apiKind: "openai-chat-completions",
    apiKey,
  });
  log("stored Nvidia API key from env");
}

async function probeMcp(): Promise<void> {
  const preset = getMcpPreset("context7");
  if (!preset) {
    throw new Error("Context7 preset missing.");
  }
  await upsertMcpServer(WORKSPACE_ID, {
    ...preset.config,
    id: "context7",
    label: preset.label,
    enabled: true,
    presetId: preset.presetId,
  });
  log("upserted Context7 MCP server");

  const status = await testMcpServer({
    workspaceId: WORKSPACE_ID,
    workspaceRoot: WORKSPACE_ROOT,
    serverId: "context7",
  });
  log("Context7 test", JSON.stringify(status));
  if (!status.connected) {
    throw new Error(`Context7 not connected: ${status.error ?? "unknown"}`);
  }

  await refreshWorkspaceMcpMirror({
    workspaceId: WORKSPACE_ID,
    workspaceRoot: WORKSPACE_ROOT,
  });
  const mirrorIndex = path.join(WORKSPACE_ROOT, "mcp-servers", "_index.md");
  if (await fs.stat(mirrorIndex).then(() => true).catch(() => false)) {
    log("mirror written", mirrorIndex);
  }

  const toolResult = await callMcpTool({
    workspaceId: WORKSPACE_ID,
    workspaceRoot: WORKSPACE_ROOT,
    serverId: "context7",
    toolName: "resolve-library-id",
    arguments: {
      query: "How do React hooks work?",
      libraryName: "React",
    },
  });
  const preview = toolResult.slice(0, 400).replace(/\s+/g, " ");
  log("call_mcp_tool resolve-library-id", `${preview}${toolResult.length > 400 ? "…" : ""}`);
}

async function probeMinimaxLlm(): Promise<void> {
  const runtime = await resolveCesiumModelRuntime({
    modelId: MODEL_ID,
    configuredApiKind: "openai-chat-completions",
  });
  const auth = await resolveCesiumAuth({ modelId: MODEL_ID });
  log("runtime", `${runtime.providerId} ${runtime.apiKind} ${runtime.baseUrl ?? ""}`);
  log("model", modelPart(MODEL_ID));

  const summaries = [
    {
      id: "context7",
      label: "Context7",
      summary: "Library docs and code examples",
    },
  ];
  const system = buildCesiumSystemPrompt({ mcpSummaries: summaries });
  const baseUrl = (auth.baseUrl ?? "https://integrate.api.nvidia.com/v1").replace(/\/+$/, "");
  const url = `${baseUrl}/chat/completions`;

  const userPrompt =
    "Reply with one short sentence only: confirm you can see the MCP section in your system prompt.";

  log("LLM request started (Minimax can take several minutes)", url);
  const started = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${auth.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: modelPart(MODEL_ID),
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 256,
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      `Minimax chat failed (${response.status}) after ${elapsedSec}s: ${JSON.stringify(payload).slice(0, 500)}`
    );
  }
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const message = (choices[0] as { message?: { content?: string } })?.message;
  const text = typeof message?.content === "string" ? message.content.trim() : "";
  log(`LLM response (${elapsedSec}s)`, text || JSON.stringify(payload).slice(0, 300));
}

async function main(): Promise<void> {
  log("DATA_DIR", DATA_DIR);
  log("WORKSPACE_ROOT", WORKSPACE_ROOT);
  await ensureProbeWorkspace();
  await maybeStoreNvidiaKey();
  await probeMcp();

  if (process.env.MCP_PROBE_SKIP_LLM === "1") {
    log("done", "MCP-only (MCP_PROBE_SKIP_LLM=1)");
    return;
  }

  try {
    await probeMinimaxLlm();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/No API key|not configured/i.test(message)) {
      log(
        "skipped LLM",
        "Set NVAPI_KEY or add Nvidia key in app settings (Cesium Agent)."
      );
      return;
    }
    throw error;
  }
  log("done", "MCP + Minimax OK");
}

main().catch((error) => {
  console.error("[mcp-probe] FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

/**
 * Probe Cesium agent lifecycle (create + prompt + poll).
 * Usage: npx tsx ./scripts/cesium-lifecycle-probe.ts [modelId] [workspaceId]
 */
import "../src/env-bootstrap.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modelId = process.argv[2]?.trim() || "cerebras/llama3.1-8b";
const workspaceId = process.argv[3]?.trim();
const serverBase = process.env.OPENCURSOR_SERVER_URL?.trim() || "http://localhost:9100";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function resolveWorkspaceId(): Promise<string> {
  if (workspaceId) {
    return workspaceId;
  }
  const { DATA_DIR } = await import("../src/lib/persistence.js");
  const registryPath = path.join(DATA_DIR, "workspaces", "registry.json");
  try {
    const raw = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      workspaces?: Array<{ id: string; root: string }>;
    };
    const match =
      raw.workspaces?.find((entry) =>
        path.resolve(entry.root).toLowerCase() === path.resolve(repoRoot).toLowerCase()
      ) ?? raw.workspaces?.[0];
    if (match?.id) {
      return match.id;
    }
  } catch {
    // fall through
  }
  throw new Error(
    "Pass workspace id as argv[3] or ensure workspace registry exists under DATA_DIR."
  );
}

async function main(): Promise<void> {
  const wsId = await resolveWorkspaceId();
  console.log("[lifecycle-probe] workspace", wsId);
  console.log("[lifecycle-probe] model", modelId);
  console.log("[lifecycle-probe] server", serverBase);

  const createBody = {
    conversation: { backendId: "cesium-agent", modelId },
    text: "Reply with exactly one token: LIFECYCLE_OK",
  };
  const createRes = await fetch(
    `${serverBase}/api/agents/conversations/create-and-prompt`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencursor-workspace-id": wsId,
      },
      body: JSON.stringify(createBody),
    }
  );
  const createText = await createRes.text();
  if (!createRes.ok) {
    throw new Error(`create-and-prompt ${createRes.status}: ${createText.slice(0, 800)}`);
  }
  const created = JSON.parse(createText) as {
    snapshot: {
      conversation: { id: string; status: string; lastError?: string | null };
      events: Array<{ kind: string; text?: string; level?: string }>;
    };
  };
  const conversationId = created.snapshot.conversation.id;
  console.log(
    "[lifecycle-probe] created",
    conversationId,
    "status=",
    created.snapshot.conversation.status,
    "events=",
    created.snapshot.events.length
  );

  for (let i = 0; i < 24; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const pollRes = await fetch(
      `${serverBase}/api/agents/conversations/${encodeURIComponent(conversationId)}?full=1`,
      { headers: { "x-opencursor-workspace-id": wsId } }
    );
    const pollText = await pollRes.text();
    if (!pollRes.ok) {
      console.log(`[lifecycle-probe] poll ${i} failed`, pollRes.status, pollText.slice(0, 200));
      continue;
    }
    const polled = JSON.parse(pollText) as {
      snapshot: {
        conversation: { status: string; lastError?: string | null };
        events: Array<{ kind: string; text?: string; level?: string }>;
      };
    };
    const status = polled.snapshot.conversation.status;
    const lastEvents = polled.snapshot.events.slice(-4);
    console.log(
      `[lifecycle-probe] poll ${i}`,
      "status=",
      status,
      "events=",
      polled.snapshot.events.length,
      "error=",
      polled.snapshot.conversation.lastError ?? ""
    );
    for (const event of lastEvents) {
      const preview =
        typeof event.text === "string" ? event.text.slice(0, 120).replace(/\s+/g, " ") : "";
      console.log(`  - ${event.kind}${event.level ? `(${event.level})` : ""} ${preview}`);
    }
    if (status === "idle" || status === "failed" || status === "cancelled") {
      if (status === "failed") {
        process.exitCode = 1;
      }
      return;
    }
  }
  console.log("[lifecycle-probe] timed out while waiting for terminal status");
  process.exitCode = 1;
}

main().catch((error) => {
  console.error("[lifecycle-probe] FAILED", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

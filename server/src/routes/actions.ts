import { spawn } from "node:child_process";
import { Hono } from "hono";
import {
  QUICK_ACTION_PRESETS,
  findEffectiveQuickAction,
  type QuickActionRunResult,
} from "@cesium/core/quick-actions";
import {
  getQuickActionsConfig,
  removeCustomQuickAction,
  setQuickActionPresetStates,
  upsertCustomQuickAction,
} from "../lib/quick-actions-store.js";
import { requireWorkspaceFromRequest } from "../lib/request-workspace.js";
import { agentRuntimeManager } from "../lib/agents/runtime-manager.js";

const COMMAND_TIMEOUT_MS = 120_000;
const OUTPUT_LIMIT_BYTES = 200_000;

export const actionsRoutes = new Hono();

actionsRoutes.get("/api/actions", async (c) => {
  const config = await getQuickActionsConfig();
  return c.json({ config, presets: QUICK_ACTION_PRESETS });
});

actionsRoutes.put("/api/actions/custom/:actionId", async (c) => {
  const actionId = c.req.param("actionId");
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  try {
    const action = await upsertCustomQuickAction({ ...body, id: actionId });
    const config = await getQuickActionsConfig();
    return c.json({ ok: true, action, config });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid quick action.";
    return c.json({ error: message }, 400);
  }
});

actionsRoutes.delete("/api/actions/custom/:actionId", async (c) => {
  const actionId = c.req.param("actionId");
  const removed = await removeCustomQuickAction(actionId);
  if (!removed) {
    return c.json({ error: `Unknown quick action: ${actionId}` }, 404);
  }
  const config = await getQuickActionsConfig();
  return c.json({ ok: true, config });
});

actionsRoutes.patch("/api/actions/presets", async (c) => {
  const body = await c.req
    .json<{ states?: Record<string, unknown> }>()
    .catch(() => ({ states: undefined }));
  if (!body.states || typeof body.states !== "object") {
    return c.json({ error: "Expected { states: Record<presetId, boolean> }." }, 400);
  }
  const config = await setQuickActionPresetStates(body.states);
  return c.json({ ok: true, config });
});

function truncateOutput(value: string): string {
  if (value.length <= OUTPUT_LIMIT_BYTES) {
    return value;
  }
  return `${value.slice(0, OUTPUT_LIMIT_BYTES)}\n... truncated ...`;
}

async function runShellCommand(
  command: string,
  cwd: string
): Promise<{ exitCode: number | null; stdout: string; stderr: string; durationMs: number }> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (stdout.length < OUTPUT_LIMIT_BYTES * 2) {
        stdout += String(chunk);
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length < OUTPUT_LIMIT_BYTES * 2) {
        stderr += String(chunk);
      }
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s.`));
    }, COMMAND_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code,
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

actionsRoutes.post("/api/actions/:actionId/run", async (c) => {
  const actionId = c.req.param("actionId");
  const config = await getQuickActionsConfig();
  const action = findEffectiveQuickAction(config, actionId);
  if (!action) {
    return c.json({ error: `Unknown or disabled quick action: ${actionId}` }, 404);
  }

  if (action.kind === "ui") {
    // UI actions execute client-side; report the definition so SDK callers can
    // still introspect what would run.
    const result: QuickActionRunResult = { ok: true, actionId, kind: "ui" };
    return c.json({ result, action });
  }

  let workspace;
  try {
    workspace = await requireWorkspaceFromRequest(c);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Workspace required.";
    return c.json({ error: message }, 400);
  }

  if (action.kind === "command") {
    const command = action.command?.trim();
    if (!command) {
      return c.json({ error: "Quick action has no command." }, 400);
    }
    try {
      const output = await runShellCommand(command, workspace.root);
      const result: QuickActionRunResult = {
        ok: output.exitCode === 0,
        actionId,
        kind: "command",
        exitCode: output.exitCode,
        stdout: output.stdout,
        stderr: output.stderr,
        durationMs: output.durationMs,
        ...(output.exitCode === 0
          ? {}
          : { error: `Command exited with code ${output.exitCode ?? "unknown"}.` }),
      };
      return c.json({ result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Command failed.";
      const result: QuickActionRunResult = {
        ok: false,
        actionId,
        kind: "command",
        error: message,
      };
      return c.json({ result }, 500);
    }
  }

  // kind === "prompt"
  const body = await c.req.json<{ conversationId?: string }>().catch(() => ({}) as { conversationId?: string });
  const conversationId = body.conversationId?.trim();
  const promptText = action.prompt?.trim();
  if (!promptText) {
    return c.json({ error: "Quick action has no prompt." }, 400);
  }
  if (!conversationId) {
    return c.json({ error: "Prompt actions require a conversationId." }, 400);
  }
  try {
    const snapshot = await agentRuntimeManager.promptConversation(
      workspace,
      conversationId,
      promptText,
      undefined,
      {}
    );
    const queued = snapshot.conversation.queuedPrompts.some(
      (item) => item.text === promptText
    );
    const result: QuickActionRunResult = {
      ok: true,
      actionId,
      kind: "prompt",
      conversationId,
      queued,
    };
    return c.json({ result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Prompt failed.";
    const result: QuickActionRunResult = {
      ok: false,
      actionId,
      kind: "prompt",
      conversationId,
      error: message,
    };
    return c.json({ result }, 500);
  }
});

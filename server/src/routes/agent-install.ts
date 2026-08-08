import { spawn } from "node:child_process";
import { Hono } from "hono";
import {
  AGENT_BACKENDS,
  listAgentBackendsWithCache,
  refreshAgentBackendRuntimes,
} from "../lib/agents/providers.js";
import { getCesiumAgentSettings } from "../lib/cesium-agent-settings.js";
import {
  getInstallSpecForBackend,
  isInstallSupportedOnThisHost,
} from "../lib/agents/install/cli-install-registry.js";

export const agentInstallRoutes = new Hono();

const INSTALL_TIMEOUT_MS = 5 * 60_000;

/** Serialize installs — a second concurrent global npm install would race. */
let installInFlight: Promise<unknown> | null = null;

/**
 * Backend catalog for the setup flow: every backend with availability plus
 * one-click installer metadata where an installer exists for this host.
 */
agentInstallRoutes.get("/api/agents/backends", async (c) => {
  const backends = await listAgentBackendsWithCache();
  // The Cesium Agent's effective default model lives in settings (env
  // bootstrap / user choice), not the static registry entry.
  const cesiumDefaultModelId = await getCesiumAgentSettings()
    .then((settings) => settings.defaultModelId)
    .catch(() => null);
  const payload = backends.map((backend) => {
    const spec = getInstallSpecForBackend(backend.id);
    const defaultModelId =
      backend.id === "cesium-agent" && cesiumDefaultModelId
        ? cesiumDefaultModelId
        : backend.defaultModelId;
    return {
      id: backend.id,
      label: backend.label,
      description: backend.description,
      available: backend.available,
      experimental: backend.experimental,
      commandPreview: backend.commandPreview ?? null,
      defaultModelId,
      defaultModelName:
        defaultModelId === backend.defaultModelId
          ? backend.defaultModelName
          : defaultModelId,
      installer:
        spec && isInstallSupportedOnThisHost(spec)
          ? {
              label: spec.label,
              summary: spec.summary,
              authHint: spec.authHint,
            }
          : null,
    };
  });
  c.header("cache-control", "no-store");
  return c.json({ backends: payload, platform: process.platform });
});

/**
 * One-click install of a harness CLI. Streams NDJSON progress lines:
 *   {"type":"log","line":"..."}
 *   {"type":"done","ok":true,"available":true}
 */
agentInstallRoutes.post("/api/agents/backends/:backendId/install", async (c) => {
  const backendId = c.req.param("backendId");
  const spec = getInstallSpecForBackend(backendId);
  if (!spec) {
    return c.json(
      { error: `No one-click installer is registered for backend ${backendId}.` },
      404
    );
  }
  if (!isInstallSupportedOnThisHost(spec)) {
    return c.json(
      { error: `${spec.label} cannot be auto-installed on ${process.platform}.` },
      400
    );
  }
  if (installInFlight) {
    return c.json({ error: "Another install is already running." }, 409);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (payload: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      };
      emit({ type: "log", line: `$ ${spec.summary}` });

      const child = spawn(spec.command, spec.args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        shell: process.platform === "win32",
      });
      const timeout = setTimeout(() => {
        emit({ type: "log", line: "Install timed out; terminating." });
        child.kill("SIGTERM");
      }, INSTALL_TIMEOUT_MS);

      const forward = (chunk: Buffer) => {
        for (const line of chunk.toString().split(/\r?\n/)) {
          if (line.trim()) {
            emit({ type: "log", line });
          }
        }
      };
      child.stdout?.on("data", forward);
      child.stderr?.on("data", forward);

      const done = new Promise<void>((resolve) => {
        child.on("error", (error) => {
          clearTimeout(timeout);
          emit({ type: "done", ok: false, error: error.message, available: false });
          controller.close();
          resolve();
        });
        child.on("close", (code) => {
          clearTimeout(timeout);
          refreshAgentBackendRuntimes();
          const available = AGENT_BACKENDS[spec.backendId]?.available ?? false;
          if (code === 0) {
            emit({ type: "done", ok: true, available, authHint: spec.authHint });
          } else {
            emit({
              type: "done",
              ok: false,
              error: `Installer exited with code ${code}.`,
              available,
            });
          }
          controller.close();
          resolve();
        });
      });
      installInFlight = done.finally(() => {
        installInFlight = null;
      });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
    },
  });
});

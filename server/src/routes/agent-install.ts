import { spawn } from "node:child_process";
import { Hono } from "hono";
import {
  AGENT_BACKENDS,
  listAgentBackendsWithCache,
} from "../lib/agents/providers.js";
import { refreshHarnessCliDetection } from "../lib/agents/harness-runtime.js";
import { getCesiumAgentSettings } from "../lib/cesium-agent-settings.js";
import {
  buildInstallCommand,
  getInstallSpecForBackend,
  isInstallSupportedOnThisHost,
  type BinaryArchiveInstallSpec,
  type CliInstallSpec,
} from "../lib/agents/install/cli-install-registry.js";
import { installBinaryArchive } from "../lib/agents/install/binary-archive-installer.js";

export const agentInstallRoutes = new Hono();

const INSTALL_TIMEOUT_MS = 5 * 60_000;
/** Multi-hundred-MB vendor archives on slow links need far longer than npm. */
const BINARY_ARCHIVE_INSTALL_TIMEOUT_MS = 45 * 60_000;

function describeInstaller(spec: CliInstallSpec) {
  return {
    kind: spec.kind,
    label: spec.label,
    summary: spec.summary,
    authHint: spec.authHint,
    ...(spec.kind === "binary-archive"
      ? {
          approxDownloadBytes: spec.approxDownloadBytes,
          approxInstalledBytes: spec.approxInstalledBytes,
          pinnedVersion: spec.fallbackManifest.version,
          manifestUrl: spec.manifestUrl,
        }
      : {}),
  };
}

/** Serialize installs - a second concurrent global npm install would race. */
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
      installer: spec && isInstallSupportedOnThisHost(spec) ? describeInstaller(spec) : null,
    };
  });
  c.header("cache-control", "no-store");
  return c.json({ backends: payload, platform: process.platform, arch: process.arch });
});

function streamBinaryArchiveInstall(spec: BinaryArchiveInstallSpec): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const emit = (payload: Record<string, unknown>) => {
        if (closed) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
        } catch {
          closed = true;
        }
      };
      const abort = new AbortController();
      const timeout = setTimeout(() => {
        emit({ type: "log", line: "Install timed out; aborting." });
        abort.abort();
      }, BINARY_ARCHIVE_INSTALL_TIMEOUT_MS);
      const done = installBinaryArchive(spec, {
        signal: abort.signal,
        emit: (event) => emit(event as unknown as Record<string, unknown>),
      })
        .then((result) => {
          refreshHarnessCliDetection();
          const available = AGENT_BACKENDS[spec.backendId]?.available ?? false;
          emit({
            type: "done",
            ok: true,
            available,
            authHint: spec.authHint,
            executablePath: result.executablePath,
            version: result.version,
            manifestSource: result.manifestSource,
          });
        })
        .catch((error: unknown) => {
          refreshHarnessCliDetection();
          const available = AGENT_BACKENDS[spec.backendId]?.available ?? false;
          emit({
            type: "done",
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            available,
          });
        })
        .finally(() => {
          clearTimeout(timeout);
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed by the client
          }
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
}

/**
 * One-click install of a harness CLI. Streams NDJSON progress lines:
 *   {"type":"log","line":"..."}
 *   {"type":"progress","phase":"download","receivedBytes":n,"totalBytes":n,"percent":n}  (binary archives)
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
      { error: `${spec.label} cannot be auto-installed on ${process.platform}/${process.arch}.` },
      400
    );
  }
  if (installInFlight) {
    return c.json({ error: "Another install is already running." }, 409);
  }

  if (spec.kind === "binary-archive") {
    return streamBinaryArchiveInstall(spec);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (payload: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      };
      const invocation = buildInstallCommand(spec);
      emit({ type: "log", line: `$ ${invocation.command} ${invocation.args.join(" ")}` });

      const child = spawn(invocation.command, invocation.args, {
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
          // Drop cached CLI detections so the freshly installed binary is
          // visible immediately (the TTL cache would otherwise lag ~30s).
          refreshHarnessCliDetection();
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

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export type TailscaleExposeMode = "tailnet" | "funnel";

export type TailscaleProbe = {
  installed: boolean;
  binary: string | null;
  loggedIn: boolean;
  backendState: string | null;
  dnsName: string | null;
  httpsUrl: string | null;
  serving: boolean;
  servingOurPort: boolean;
  expose: TailscaleExposeMode | null;
  lastError: string | null;
};

export type TailscaleCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type TailscaleAccessDeps = {
  findExecutable?: (name: string, envOverride?: string) => Promise<string | null>;
  runCommand?: (
    command: string,
    args: string[],
    timeoutMs?: number
  ) => Promise<TailscaleCommandResult>;
  localPort?: number;
  expose?: TailscaleExposeMode;
};

const TS_NET_URL_PATTERN = /https:\/\/[-a-z0-9.]+\.ts\.net\b/gi;

export function normalizeTailscaleExpose(value: unknown): TailscaleExposeMode {
  if (value === undefined || value === null || value === "") {
    return "tailnet";
  }
  if (value === "tailnet" || value === "funnel") {
    return value;
  }
  throw new Error("CESIUM_TAILSCALE_EXPOSE must be tailnet or funnel.");
}

export function tailscaleHttpsUrlFromDnsName(dnsName: string | null | undefined): string | null {
  if (!dnsName) return null;
  const host = dnsName.trim().replace(/\.+$/, "").toLowerCase();
  if (!host.endsWith(".ts.net") || host.includes("/") || host.includes(":")) {
    return null;
  }
  return `https://${host}`;
}

export function extractTailscaleHttpsUrl(input: string): string | null {
  TS_NET_URL_PATTERN.lastIndex = 0;
  let latest: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = TS_NET_URL_PATTERN.exec(input))) {
    latest = match[0].replace(/\/+$/, "");
  }
  if (latest) return latest;
  const hostMatch = /(?:^|[\s"'])((?:[-a-z0-9]+\.)+ts\.net)(?::\d+)?(?:\b|$)/i.exec(input);
  return tailscaleHttpsUrlFromDnsName(hostMatch?.[1] ?? null);
}

export function formatTailscaleDoctorLine(probe: TailscaleProbe): string {
  if (!probe.installed) {
    return "Tailscale: not installed (optional; localhost.run / Cloudflare still work)";
  }
  if (!probe.loggedIn) {
    const state = probe.backendState ? ` (${probe.backendState})` : "";
    return `Tailscale: needs login${state}. Run \`tailscale login\`, then choose the Tailscale tunnel provider.`;
  }
  if (probe.serving && probe.httpsUrl) {
    const scope = probe.expose === "funnel" ? "funnel" : "tailnet";
    return `Tailscale: serving ${scope} (${probe.httpsUrl})`;
  }
  if (probe.httpsUrl) {
    return `Tailscale: ready (${probe.httpsUrl}), not serving`;
  }
  return `Tailscale: ready (${probe.backendState ?? "Running"}), MagicDNS name unavailable`;
}

type TailscaleStatusJson = {
  BackendState?: unknown;
  AuthURL?: unknown;
  Self?: {
    DNSName?: unknown;
    HostName?: unknown;
  };
};

type TailscaleServeStatusJson = {
  Web?: Record<string, unknown>;
  Funnel?: Record<string, unknown>;
  TCP?: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseTailscaleStatusJson(raw: string): {
  backendState: string | null;
  dnsName: string | null;
  httpsUrl: string | null;
} {
  const parsed = JSON.parse(raw) as TailscaleStatusJson;
  const backendState = typeof parsed.BackendState === "string" ? parsed.BackendState : null;
  const self = asRecord(parsed.Self);
  const dnsName = typeof self?.DNSName === "string" ? self.DNSName : null;
  return {
    backendState,
    dnsName,
    httpsUrl: tailscaleHttpsUrlFromDnsName(dnsName),
  };
}

export function parseTailscaleServeStatus(
  raw: string,
  localPort: number
): {
  serving: boolean;
  servingOurPort: boolean;
  expose: TailscaleExposeMode | null;
  httpsUrl: string | null;
} {
  const trimmed = raw.trim();
  if (!trimmed || /^no serve config/i.test(trimmed)) {
    return { serving: false, servingOurPort: false, expose: null, httpsUrl: null };
  }
  let parsed: TailscaleServeStatusJson;
  try {
    parsed = JSON.parse(trimmed) as TailscaleServeStatusJson;
  } catch {
    return {
      serving: Boolean(extractTailscaleHttpsUrl(trimmed)),
      servingOurPort: trimmed.includes(`:${localPort}`) || trimmed.includes(`127.0.0.1:${localPort}`),
      expose: /funnel|internet/i.test(trimmed) ? "funnel" : "tailnet",
      httpsUrl: extractTailscaleHttpsUrl(trimmed),
    };
  }

  const web = asRecord(parsed.Web) ?? {};
  const funnel = asRecord(parsed.Funnel) ?? {};
  const webKeys = Object.keys(web);
  const serving = webKeys.length > 0 || Object.keys(asRecord(parsed.TCP) ?? {}).length > 0;
  const blob = JSON.stringify(parsed);
  const servingOurPort =
    blob.includes(`127.0.0.1:${localPort}`) ||
    blob.includes(`localhost:${localPort}`) ||
    blob.includes(`http://127.0.0.1:${localPort}`) ||
    new RegExp(`:${localPort}(?:\\D|$)`).test(blob);
  const httpsUrl =
    extractTailscaleHttpsUrl(webKeys.join("\n")) ??
    extractTailscaleHttpsUrl(Object.keys(funnel).join("\n")) ??
    extractTailscaleHttpsUrl(blob);
  return {
    serving,
    servingOurPort,
    expose: Object.keys(funnel).length > 0 ? "funnel" : serving ? "tailnet" : null,
    httpsUrl,
  };
}

async function defaultFindExecutable(
  name: string,
  envOverride?: string
): Promise<string | null> {
  const override = envOverride?.trim();
  if (override) {
    try {
      await fs.access(override);
      return override;
    } catch {
      return null;
    }
  }
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidates =
      process.platform === "win32" && !name.toLowerCase().endsWith(".exe")
        ? [path.join(entry, `${name}.exe`), path.join(entry, name)]
        : [path.join(entry, name)];
    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return null;
}

async function defaultRunCommand(
  command: string,
  args: string[],
  timeoutMs = 15_000
): Promise<TailscaleCommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Timed out running ${command} ${args.join(" ")}`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function commandFailed(result: TailscaleCommandResult): string {
  return (result.stderr || result.stdout || `exit ${result.code}`).trim().slice(0, 400);
}

export async function probeTailscale(deps: TailscaleAccessDeps = {}): Promise<TailscaleProbe> {
  const findExecutable = deps.findExecutable ?? defaultFindExecutable;
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const localPort = deps.localPort ?? Number.parseInt(process.env.PORT ?? "9100", 10);
  const empty: TailscaleProbe = {
    installed: false,
    binary: null,
    loggedIn: false,
    backendState: null,
    dnsName: null,
    httpsUrl: null,
    serving: false,
    servingOurPort: false,
    expose: null,
    lastError: null,
  };

  const binary = await findExecutable("tailscale", process.env.CESIUM_TAILSCALE_BIN);
  if (!binary) {
    return empty;
  }

  try {
    const statusResult = await runCommand(binary, ["status", "--json"]);
    if (statusResult.code !== 0) {
      return {
        ...empty,
        installed: true,
        binary,
        lastError: commandFailed(statusResult),
      };
    }
    const status = parseTailscaleStatusJson(statusResult.stdout);
    const loggedIn = status.backendState === "Running";
    let serving = false;
    let servingOurPort = false;
    let expose: TailscaleExposeMode | null = null;
    let serveUrl: string | null = null;
    if (loggedIn) {
      const serveResult = await runCommand(binary, ["serve", "status", "--json"]);
      const parsed = parseTailscaleServeStatus(
        serveResult.code === 0 ? serveResult.stdout : serveResult.stderr || serveResult.stdout,
        localPort
      );
      serving = parsed.serving;
      servingOurPort = parsed.servingOurPort;
      expose = parsed.expose;
      serveUrl = parsed.httpsUrl;
    }
    return {
      installed: true,
      binary,
      loggedIn,
      backendState: status.backendState,
      dnsName: status.dnsName,
      httpsUrl: serveUrl ?? status.httpsUrl,
      serving,
      servingOurPort,
      expose,
      lastError: loggedIn
        ? null
        : status.backendState
          ? `Tailscale is ${status.backendState}. Run \`tailscale login\`.`
          : "Tailscale is installed but not logged in. Run `tailscale login`.",
    };
  } catch (error) {
    return {
      ...empty,
      installed: true,
      binary,
      lastError: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function enableTailscaleAccess(
  deps: TailscaleAccessDeps = {}
): Promise<{ url: string; probe: TailscaleProbe }> {
  const probe = await probeTailscale(deps);
  if (!probe.installed || !probe.binary) {
    throw new Error(
      "The Tailscale CLI is not installed. Install Tailscale, run `tailscale login`, or keep using localhost.run / Cloudflare."
    );
  }
  if (!probe.loggedIn) {
    throw new Error(
      probe.lastError ??
        "Tailscale is installed but not logged in. Run `tailscale login`, then retry."
    );
  }
  const url = probe.httpsUrl;
  if (!url) {
    throw new Error(
      "Tailscale is logged in but has no MagicDNS name. Enable HTTPS / MagicDNS in the Tailscale admin console."
    );
  }
  if (probe.servingOurPort) {
    return { url, probe };
  }
  if (probe.serving && !probe.servingOurPort) {
    throw new Error(
      "Tailscale Serve is already publishing a different local service. Run `tailscale serve status` and free that mapping, or keep using localhost.run / Cloudflare."
    );
  }

  const runCommand = deps.runCommand ?? defaultRunCommand;
  const localPort = deps.localPort ?? Number.parseInt(process.env.PORT ?? "9100", 10);
  const expose = deps.expose ?? normalizeTailscaleExpose(process.env.CESIUM_TAILSCALE_EXPOSE);
  const verb = expose === "funnel" ? "funnel" : "serve";
  const attempts: string[][] = [
    [verb, "--bg", "--yes", String(localPort)],
    [verb, "--bg", "--yes", "--https=443", `http://127.0.0.1:${localPort}`],
  ];
  let lastError = "";
  for (const args of attempts) {
    const result = await runCommand(probe.binary, args);
    if (result.code === 0) {
      const published =
        extractTailscaleHttpsUrl(`${result.stdout}\n${result.stderr}`) ?? url;
      const next = await probeTailscale(deps);
      return { url: next.httpsUrl ?? published, probe: { ...next, expose } };
    }
    lastError = commandFailed(result);
  }
  throw new Error(
    `Tailscale ${verb} failed: ${lastError || "unknown error"}. HTTPS certificates must be enabled on the tailnet.`
  );
}

export async function disableTailscaleAccess(deps: TailscaleAccessDeps = {}): Promise<void> {
  const probe = await probeTailscale(deps);
  if (!probe.installed || !probe.binary || !probe.servingOurPort) {
    return;
  }
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const resets = [
    ["serve", "reset"],
    ["funnel", "reset"],
    ["serve", "off"],
  ];
  for (const args of resets) {
    const result = await runCommand(probe.binary, args);
    if (result.code === 0) {
      return;
    }
  }
}

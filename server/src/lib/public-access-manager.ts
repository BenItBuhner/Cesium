import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import {
  createCipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDataDir, readJsonFile } from "./persistence.js";
import { isAuthEnabled, rotateAuthSecurityState } from "./auth.js";

export type PublicAccessProvider = "auto" | "localhost-run" | "cloudflare-quick";

export type PublicAccessConfig = {
  schemaVersion: 1;
  enabled: boolean;
  webAppUrl: string;
  provider: PublicAccessProvider;
  customPublicUrl?: string;
  serverId: string;
  rendezvousReadSecret: string;
  rendezvousWriteSecret: string;
  managedAuthUsername: string | null;
  managedAuthPassword: string | null;
  credentialsManagerGenerated: boolean;
  label?: string;
  createdAt: number;
  updatedAt: number;
};

export type PublicAccessConfigInput = {
  webAppUrl?: unknown;
  provider?: unknown;
  customPublicUrl?: unknown;
  label?: unknown;
};

export type PublicAccessStatus = {
  configured: boolean;
  enabled: boolean;
  webAppUrl: string | null;
  webAppOrigin: string | null;
  provider: PublicAccessProvider | "custom" | null;
  customPublicUrl: string | null;
  serverId: string | null;
  label: string | null;
  publicUrl: string | null;
  connectUrl: string | null;
  auth: {
    enabled: boolean;
    username: string | null;
    credentialsManagerGenerated: boolean;
    managedRuntimeCredentials: boolean;
    externallyConfigured: boolean;
  };
  tunnel: {
    running: boolean;
    provider: PublicAccessProvider | "custom" | null;
    pid: number | null;
    healthFailures: number;
    lastError: string | null;
  };
  rendezvous: {
    registryOrigin: string | null;
    lastPublishedAt: number | null;
    lastError: string | null;
  };
};

export type GeneratedPublicAccessCredentials = {
  username: string;
  password: string;
};

type PublicAccessChild = Pick<
  ChildProcessWithoutNullStreams,
  "pid" | "stdout" | "stderr" | "kill" | "killed" | "on"
>;

type PublicAccessManagerDeps = {
  configFilePath?: string;
  runDir?: string | null;
  host?: string;
  port?: number;
  now?: () => number;
  fetch?: typeof fetch;
  spawn?: (
    command: string,
    args: string[],
    options: SpawnOptions
  ) => PublicAccessChild;
  findExecutable?: (name: string, envOverride?: string) => Promise<string | null>;
  healthTimeoutMs?: number;
  tunnelStartupTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  healthIntervalMs?: number;
  restartDelayMs?: number;
  registerSignals?: boolean;
};

type EnableResult = {
  status: PublicAccessStatus;
  generatedCredentials?: GeneratedPublicAccessCredentials;
};

const CONFIG_FILE = path.join(DATA_DIR, "profile", "public-access.json");
const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{24,80}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const LHR_URL_PATTERN = /https:\/\/[-a-z0-9]+\.lhr\.life/gi;
const TRY_CLOUDFLARE_PATTERN = /https:\/\/[-a-z0-9]+\.trycloudflare\.com/gi;

export class PublicAccessError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
  }
}

function base64UrlRandom(byteLength: number): string {
  return randomBytes(byteLength).toString("base64url");
}

function isLocalHttpHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function normalizeHttpOrigin(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PublicAccessError(`${fieldName} is required.`);
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new PublicAccessError(`${fieldName} must be an absolute URL.`);
  }
  if (url.username || url.password) {
    throw new PublicAccessError(`${fieldName} must not include credentials.`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHttpHost(url.hostname))) {
    throw new PublicAccessError(`${fieldName} must use HTTPS, except local HTTP for development.`);
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.origin;
}

function normalizePublicBaseUrl(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PublicAccessError(`${fieldName} is required.`);
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new PublicAccessError(`${fieldName} must be an absolute URL.`);
  }
  if (url.protocol !== "https:") {
    throw new PublicAccessError(`${fieldName} must use HTTPS.`);
  }
  if (url.username || url.password) {
    throw new PublicAccessError(`${fieldName} must not include credentials.`);
  }
  url.hash = "";
  url.search = "";
  url.pathname = "";
  return url.toString().replace(/\/+$/, "");
}

function normalizeProvider(value: unknown): PublicAccessProvider {
  if (value === undefined || value === null || value === "") {
    return "auto";
  }
  if (value === "auto" || value === "localhost-run" || value === "cloudflare-quick") {
    return value;
  }
  throw new PublicAccessError("provider must be auto, localhost-run, or cloudflare-quick.");
}

function normalizeLabel(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new PublicAccessError("label must be a string.");
  }
  const label = value.trim();
  if (!label) return undefined;
  if (label.length > 120) {
    throw new PublicAccessError("label must be 120 characters or fewer.");
  }
  return label;
}

function validateSecret(value: string, fieldName: string): string {
  if (!SECRET_PATTERN.test(value)) {
    throw new PublicAccessError(`${fieldName} is invalid.`);
  }
  return value;
}

function validateServerId(value: string): string {
  if (!SERVER_ID_PATTERN.test(value)) {
    throw new PublicAccessError("serverId is invalid.");
  }
  return value;
}

async function writeJsonFileMode600(filePath: string, data: unknown): Promise<void> {
  await ensureDataDir();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  const tempPath = `${filePath}.${process.pid}.${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}.tmp`;
  await fs.writeFile(tempPath, payload, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(tempPath, 0o600).catch(() => undefined);
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, 0o600).catch(() => undefined);
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

function extractLatestUrl(input: string, provider: PublicAccessProvider): string | null {
  const pattern = provider === "cloudflare-quick" ? TRY_CLOUDFLARE_PATTERN : LHR_URL_PATTERN;
  pattern.lastIndex = 0;
  let latest: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input))) {
    latest = match[0];
  }
  return latest;
}

function parsePersistedConfig(value: PublicAccessConfig | null): PublicAccessConfig | null {
  if (!value || value.schemaVersion !== 1) return null;
  if (!value.webAppUrl || !value.serverId || !value.rendezvousReadSecret || !value.rendezvousWriteSecret) {
    return null;
  }
  return {
    schemaVersion: 1,
    enabled: value.enabled === true,
    webAppUrl: normalizeHttpOrigin(value.webAppUrl, "webAppUrl"),
    provider: normalizeProvider(value.provider),
    ...(value.customPublicUrl
      ? { customPublicUrl: normalizePublicBaseUrl(value.customPublicUrl, "customPublicUrl") }
      : {}),
    serverId: validateServerId(value.serverId),
    rendezvousReadSecret: validateSecret(value.rendezvousReadSecret, "rendezvousReadSecret"),
    rendezvousWriteSecret: validateSecret(value.rendezvousWriteSecret, "rendezvousWriteSecret"),
    managedAuthUsername:
      typeof value.managedAuthUsername === "string" && value.managedAuthUsername.trim()
        ? value.managedAuthUsername.trim()
        : null,
    managedAuthPassword:
      typeof value.managedAuthPassword === "string" && value.managedAuthPassword
        ? value.managedAuthPassword
        : null,
    credentialsManagerGenerated: value.credentialsManagerGenerated === true,
    ...(value.label ? { label: normalizeLabel(value.label) } : {}),
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now(),
  };
}

export class PublicAccessManager {
  private config: PublicAccessConfig | null = null;
  private loaded = false;
  private loading: Promise<void> | null = null;
  private child: PublicAccessChild | null = null;
  private stoppingChild = false;
  private activeProvider: PublicAccessProvider | "custom" | null = null;
  private currentPublicUrl: string | null = null;
  private tunnelLog = "";
  private healthFailures = 0;
  private lastTunnelError: string | null = null;
  private lastRendezvousError: string | null = null;
  private lastPublishedAt: number | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private runtimeAuthOwnedByManager = false;
  private signalsRegistered = false;
  private readonly initialEnvAuthUsername = process.env.OPENCURSOR_AUTH_USERNAME?.trim() || null;
  private readonly initialEnvAuthPassword = process.env.OPENCURSOR_AUTH_PASSWORD?.trim() || null;

  constructor(private readonly deps: PublicAccessManagerDeps = {}) {}

  async start(): Promise<void> {
    await this.load();
    if (this.deps.registerSignals !== false) {
      this.registerCleanupHandlers();
    }
    if (this.config?.enabled) {
      await this.ensureAuthentication(false);
      void this.startExposure(this.config).catch((error) => {
        this.lastTunnelError = error instanceof Error ? error.message : String(error);
        console.warn("[public-access] auto-resume failed:", error);
        this.scheduleRestart();
      });
    }
  }

  isEnabledSync(): boolean {
    return this.config?.enabled === true;
  }

  getCorsOriginSync(): string | null {
    if (!this.config?.enabled) return null;
    try {
      return normalizeHttpOrigin(this.config.webAppUrl, "webAppUrl");
    } catch {
      return null;
    }
  }

  async getStatus(): Promise<PublicAccessStatus> {
    await this.load();
    return this.status();
  }

  async updateConfig(input: PublicAccessConfigInput): Promise<PublicAccessStatus> {
    await this.load();
    const previous = this.config;
    const next = this.buildConfig(input, false);
    this.config = next;
    try {
      if (next.enabled) {
        await this.startExposure(next);
      }
      await this.persistConfig();
    } catch (error) {
      this.config = previous;
      if (previous?.enabled) {
        await this.startExposure(previous).catch(() => undefined);
      } else {
        await this.stopOwnedChild();
      }
      throw error;
    }
    return this.status();
  }

  async enable(input: PublicAccessConfigInput = {}): Promise<EnableResult> {
    await this.load();
    this.config = this.buildConfig(input, true);
    const generatedCredentials = await this.ensureAuthentication(true);
    this.config.enabled = true;
    this.config.updatedAt = this.now();
    try {
      await this.startExposure(this.config);
      await this.persistConfig();
      await this.writeDisabledMarker(false);
    } catch (error) {
      this.stopTimers();
      await this.stopOwnedChild();
      this.currentPublicUrl = null;
      this.activeProvider = null;
      this.config.enabled = false;
      this.config.updatedAt = this.now();
      await this.persistConfig();
      await this.writeDisabledMarker(true);
      this.clearManagerGeneratedRuntimeAuth();
      throw error;
    }
    return {
      status: this.status(),
      ...(generatedCredentials ? { generatedCredentials } : {}),
    };
  }

  async disable(): Promise<PublicAccessStatus> {
    await this.load();
    if (this.config) {
      this.config.enabled = false;
      this.config.updatedAt = this.now();
      await this.persistConfig();
    }
    this.stopTimers();
    await this.stopOwnedChild();
    this.currentPublicUrl = null;
    this.activeProvider = null;
    await this.clearRunStatusFiles();
    await this.writeDisabledMarker(true);
    this.clearManagerGeneratedRuntimeAuth();
    return this.status();
  }

  async rotateAuth(): Promise<{ username: string; password: string; status: PublicAccessStatus }> {
    await this.load();
    const externalAuthPresent =
      Boolean(this.initialEnvAuthUsername && this.initialEnvAuthPassword) &&
      !this.runtimeAuthOwnedByManager;
    if (externalAuthPresent) {
      throw new PublicAccessError(
        "Authentication is externally configured; remove OPENCURSOR_AUTH_USERNAME/PASSWORD to rotate it through public access.",
        409
      );
    }
    this.config = this.config ?? this.buildConfig({}, false);
    const username = this.config.managedAuthUsername || process.env.OPENCURSOR_AUTH_USERNAME?.trim() || "cesium";
    const password = base64UrlRandom(32);
    process.env.OPENCURSOR_AUTH_USERNAME = username;
    process.env.OPENCURSOR_AUTH_PASSWORD = password;
    this.runtimeAuthOwnedByManager = true;
    this.config.managedAuthUsername = username;
    this.config.managedAuthPassword = password;
    this.config.credentialsManagerGenerated = true;
    this.config.updatedAt = this.now();
    await this.persistConfig();
    await rotateAuthSecurityState();
    return { username, password, status: this.status() };
  }

  async stopRuntimeOnly(): Promise<void> {
    this.stopTimers();
    await this.stopOwnedChild();
  }

  async stopRuntimeOnlyForTests(): Promise<void> {
    await this.stopRuntimeOnly();
  }

  resetForTests(): void {
    this.stopTimers();
    this.config = null;
    this.loaded = false;
    this.loading = null;
    this.child = null;
    this.stoppingChild = false;
    this.activeProvider = null;
    this.currentPublicUrl = null;
    this.tunnelLog = "";
    this.healthFailures = 0;
    this.lastTunnelError = null;
    this.lastRendezvousError = null;
    this.lastPublishedAt = null;
    this.runtimeAuthOwnedByManager = false;
  }

  replaceConfigForTests(config: PublicAccessConfig | null): void {
    this.config = config;
    this.loaded = true;
  }

  buildStableConnectUrlForTests(publicUrl: string): string {
    if (!this.config) {
      throw new PublicAccessError("Public access is not configured.");
    }
    return this.buildConnectUrl(this.config, publicUrl);
  }

  encryptedRendezvousRecordForTests(publicUrl: string, provider: string): string {
    if (!this.config) {
      throw new PublicAccessError("Public access is not configured.");
    }
    return this.encryptedRecord(this.config, publicUrl, provider);
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const persisted = parsePersistedConfig(
        await readJsonFile<PublicAccessConfig | null>(this.configFilePath, null)
      );
      this.config = persisted ?? this.bootstrapConfigFromEnv();
      if (!persisted && this.config) {
        await this.persistConfig();
      }
      if (this.config?.credentialsManagerGenerated && !isAuthEnabled()) {
        await this.ensureAuthentication(false);
      }
      this.loaded = true;
    })();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  private bootstrapConfigFromEnv(): PublicAccessConfig | null {
    if (process.env.CESIUM_BACKEND_MANAGES_PUBLIC_ACCESS?.trim() !== "1") {
      return null;
    }
    const webAppUrl = process.env.CESIUM_WEB_URL?.trim();
    const serverId = process.env.CESIUM_SERVER_ID?.trim();
    const readSecret = process.env.CESIUM_RENDEZVOUS_READ_SECRET?.trim();
    const writeSecret = process.env.CESIUM_RENDEZVOUS_WRITE_SECRET?.trim();
    if (!webAppUrl || !serverId || !readSecret || !writeSecret) {
      return null;
    }
    const now = this.now();
    const customPublicUrl = process.env.CESIUM_PUBLIC_URL?.trim();
    return {
      schemaVersion: 1,
      enabled: process.env.CESIUM_TUNNEL_ENABLED?.trim() === "1",
      webAppUrl: normalizeHttpOrigin(webAppUrl, "CESIUM_WEB_URL"),
      provider: normalizeProvider(process.env.CESIUM_TUNNEL_PROVIDER?.trim() || "auto"),
      ...(customPublicUrl
        ? { customPublicUrl: normalizePublicBaseUrl(customPublicUrl, "CESIUM_PUBLIC_URL") }
        : {}),
      serverId: validateServerId(serverId),
      rendezvousReadSecret: validateSecret(readSecret, "CESIUM_RENDEZVOUS_READ_SECRET"),
      rendezvousWriteSecret: validateSecret(writeSecret, "CESIUM_RENDEZVOUS_WRITE_SECRET"),
      managedAuthUsername: process.env.OPENCURSOR_AUTH_USERNAME?.trim() || null,
      managedAuthPassword: null,
      credentialsManagerGenerated: false,
      ...(process.env.CESIUM_SERVER_LABEL?.trim()
        ? { label: normalizeLabel(process.env.CESIUM_SERVER_LABEL) }
        : {}),
      createdAt: now,
      updatedAt: now,
    };
  }

  private buildConfig(input: PublicAccessConfigInput, enabling: boolean): PublicAccessConfig {
    const now = this.now();
    const existing = this.config;
    const webAppUrl =
      input.webAppUrl !== undefined
        ? normalizeHttpOrigin(input.webAppUrl, "webAppUrl")
        : existing?.webAppUrl;
    if (!webAppUrl) {
      throw new PublicAccessError("webAppUrl is required before enabling public access.");
    }
    const rawCustom =
      input.customPublicUrl !== undefined ? input.customPublicUrl : existing?.customPublicUrl;
    const customPublicUrl =
      rawCustom === undefined || rawCustom === null || rawCustom === ""
        ? undefined
        : normalizePublicBaseUrl(rawCustom, "customPublicUrl");
    return {
      schemaVersion: 1,
      enabled: enabling ? true : existing?.enabled === true,
      webAppUrl,
      provider: input.provider !== undefined ? normalizeProvider(input.provider) : existing?.provider ?? "auto",
      ...(customPublicUrl ? { customPublicUrl } : {}),
      serverId: existing?.serverId ?? base64UrlRandom(24),
      rendezvousReadSecret: existing?.rendezvousReadSecret ?? base64UrlRandom(32),
      rendezvousWriteSecret: existing?.rendezvousWriteSecret ?? base64UrlRandom(32),
      managedAuthUsername: existing?.managedAuthUsername ?? null,
      managedAuthPassword: existing?.managedAuthPassword ?? null,
      credentialsManagerGenerated: existing?.credentialsManagerGenerated === true,
      ...(input.label !== undefined
        ? { label: normalizeLabel(input.label) }
        : existing?.label
          ? { label: existing.label }
          : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  private async ensureAuthentication(returnNewCredentials: boolean): Promise<GeneratedPublicAccessCredentials | undefined> {
    if (!this.config) return undefined;
    const envUsername = process.env.OPENCURSOR_AUTH_USERNAME?.trim();
    const envPassword = process.env.OPENCURSOR_AUTH_PASSWORD?.trim();
    if (envUsername && envPassword && !this.runtimeAuthOwnedByManager) {
      this.config.managedAuthUsername = null;
      this.config.managedAuthPassword = null;
      this.config.credentialsManagerGenerated = false;
      return undefined;
    }
    if (
      this.config.credentialsManagerGenerated &&
      this.config.managedAuthUsername &&
      this.config.managedAuthPassword
    ) {
      process.env.OPENCURSOR_AUTH_USERNAME = this.config.managedAuthUsername;
      process.env.OPENCURSOR_AUTH_PASSWORD = this.config.managedAuthPassword;
      this.runtimeAuthOwnedByManager = true;
      return undefined;
    }
    const username = this.config.managedAuthUsername || "cesium";
    const password = base64UrlRandom(32);
    process.env.OPENCURSOR_AUTH_USERNAME = username;
    process.env.OPENCURSOR_AUTH_PASSWORD = password;
    this.runtimeAuthOwnedByManager = true;
    this.config.managedAuthUsername = username;
    this.config.managedAuthPassword = password;
    this.config.credentialsManagerGenerated = true;
    return returnNewCredentials ? { username, password } : undefined;
  }

  private clearManagerGeneratedRuntimeAuth(): void {
    if (!this.runtimeAuthOwnedByManager || !this.config?.credentialsManagerGenerated) {
      return;
    }
    if (process.env.OPENCURSOR_AUTH_USERNAME === this.config.managedAuthUsername) {
      delete process.env.OPENCURSOR_AUTH_USERNAME;
    }
    if (process.env.OPENCURSOR_AUTH_PASSWORD === this.config.managedAuthPassword) {
      delete process.env.OPENCURSOR_AUTH_PASSWORD;
    }
    this.runtimeAuthOwnedByManager = false;
  }

  private async persistConfig(): Promise<void> {
    if (!this.config) return;
    await writeJsonFileMode600(this.configFilePath, this.config);
  }

  private async startExposure(config: PublicAccessConfig): Promise<void> {
    this.stopTimers();
    this.healthFailures = 0;
    this.lastTunnelError = null;
    if (config.customPublicUrl) {
      await this.stopOwnedChild();
      await this.requireHealthy(config.customPublicUrl);
      this.currentPublicUrl = config.customPublicUrl;
      this.activeProvider = "custom";
      await this.writePublicUrlFile(config.customPublicUrl);
      this.startTimers();
      await this.publishRendezvous();
      await this.writeDisabledMarker(false);
      return;
    }
    await this.startTunnel(config.provider);
    this.startTimers();
    await this.publishRendezvous();
    await this.writeDisabledMarker(false);
  }

  private async startTunnel(provider: PublicAccessProvider): Promise<void> {
    await this.stopOwnedChild();
    this.tunnelLog = "";
    const selected = await this.resolveProvider(provider);
    this.activeProvider = selected;
    const { command, args } = await this.commandForProvider(selected);
    const child = this.spawn(command, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout?.on("data", (chunk) => this.appendTunnelLog(String(chunk)));
    child.stderr?.on("data", (chunk) => this.appendTunnelLog(String(chunk)));
    child.on("error", (error) => {
      this.lastTunnelError = error instanceof Error ? error.message : String(error);
    });
    child.on("exit", () => {
      if (this.child === child) {
        this.child = null;
      }
      if (!this.stoppingChild && this.config?.enabled) {
        this.lastTunnelError = "Tunnel process exited.";
        this.scheduleRestart();
      }
    });
    const url = await this.waitForTunnelUrl(selected);
    await this.requireHealthy(url);
    this.currentPublicUrl = url;
    await this.writePublicUrlFile(url);
  }

  private appendTunnelLog(chunk: string): void {
    this.tunnelLog = `${this.tunnelLog}${chunk}`.slice(-64_000);
    if (this.activeProvider === "localhost-run" || this.activeProvider === "cloudflare-quick") {
      const latest = extractLatestUrl(this.tunnelLog, this.activeProvider);
      if (latest) {
        void this.promoteTunnelUrlIfHealthy(latest);
      }
    }
  }

  private async promoteTunnelUrlIfHealthy(publicUrl: string): Promise<void> {
    if (publicUrl === this.currentPublicUrl) return;
    try {
      await this.requireHealthy(publicUrl);
      this.currentPublicUrl = publicUrl;
      await this.writePublicUrlFile(publicUrl);
      await this.publishRendezvous();
    } catch {
      // Keep the last known healthy URL until the new assignment proves healthy.
    }
  }

  private async resolveProvider(provider: PublicAccessProvider): Promise<PublicAccessProvider> {
    if (provider === "localhost-run") {
      const ssh = await this.findExecutable("ssh", process.env.CESIUM_SSH_BIN);
      if (!ssh) {
        throw new PublicAccessError(
          "ssh is unavailable. Install an OpenSSH client or configure a HTTPS custom public URL.",
          503
        );
      }
      return "localhost-run";
    }
    if (provider === "cloudflare-quick") {
      const cloudflared = await this.ensureCloudflared();
      if (!cloudflared) {
        throw new PublicAccessError(
          "cloudflared is unavailable. Install cloudflared or configure a HTTPS custom public URL.",
          503
        );
      }
      return "cloudflare-quick";
    }
    const ssh = await this.findExecutable("ssh", process.env.CESIUM_SSH_BIN);
    if (ssh) return "localhost-run";
    const cloudflared = await this.ensureCloudflared();
    if (cloudflared) return "cloudflare-quick";
    throw new PublicAccessError(
      "ssh is unavailable and cloudflared was not found. Install OpenSSH, install cloudflared, or configure a HTTPS custom public URL.",
      503
    );
  }

  private async commandForProvider(provider: PublicAccessProvider): Promise<{ command: string; args: string[] }> {
    const host = this.localHost;
    const port = String(this.localPort);
    if (provider === "cloudflare-quick") {
      const command = await this.ensureCloudflared();
      if (!command) {
        throw new PublicAccessError("cloudflared is unavailable.", 503);
      }
      return {
        command,
        args: ["tunnel", "--no-autoupdate", "--url", `http://${host}:${port}`],
      };
    }
    const command = await this.findExecutable("ssh", process.env.CESIUM_SSH_BIN);
    if (!command) {
      throw new PublicAccessError(
        "ssh is unavailable. Install an OpenSSH client or configure a HTTPS custom public URL.",
        503
      );
    }
    return {
      command,
      args: [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
        "-R",
        `80:${host}:${port}`,
        "nokey@localhost.run",
      ],
    };
  }

  private async ensureCloudflared(): Promise<string | null> {
    const configured = await this.findExecutable(
      "cloudflared",
      process.env.CESIUM_CLOUDFLARED_BIN
    );
    if (configured) return configured;

    const runtimeDir = path.join(DATA_DIR, "runtime", "bin");
    const executableName = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
    const target = path.join(runtimeDir, executableName);
    try {
      await fs.access(target);
      return target;
    } catch {
      // Download the official release below.
    }

    const platformKey = `${process.platform}:${process.arch}`;
    const asset = {
      "linux:x64": "cloudflared-linux-amd64",
      "linux:arm64": "cloudflared-linux-arm64",
      "darwin:x64": "cloudflared-darwin-amd64.tgz",
      "darwin:arm64": "cloudflared-darwin-arm64.tgz",
      "win32:x64": "cloudflared-windows-amd64.exe",
      "win32:arm64": "cloudflared-windows-arm64.exe",
    }[platformKey];
    if (!asset) return null;

    await fs.mkdir(runtimeDir, { recursive: true });
    const downloadUrl = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
    const response = await this.fetch(downloadUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new PublicAccessError(
        `Could not download cloudflared (${response.status}). Install OpenSSH or retry.`,
        503
      );
    }
    const payload = Buffer.from(await response.arrayBuffer());
    if (asset.endsWith(".tgz")) {
      const archive = path.join(runtimeDir, `cloudflared-${process.pid}.tgz`);
      await fs.writeFile(archive, payload, { mode: 0o600 });
      const tar = await this.findExecutable("tar");
      if (!tar) {
        await fs.rm(archive, { force: true });
        throw new PublicAccessError(
          "The downloaded cloudflared archive requires the system tar utility.",
          503
        );
      }
      await new Promise<void>((resolve, reject) => {
        const child = nodeSpawn(tar, ["-xzf", archive, "-C", runtimeDir], {
          stdio: "ignore",
        });
        child.once("error", reject);
        child.once("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`))
        );
      }).finally(() => fs.rm(archive, { force: true }));
    } else {
      const temporary = `${target}.${process.pid}.tmp`;
      await fs.writeFile(temporary, payload, { mode: 0o700 });
      await fs.rename(temporary, target);
    }
    await fs.chmod(target, 0o700).catch(() => undefined);
    return target;
  }

  private async waitForTunnelUrl(provider: PublicAccessProvider): Promise<string> {
    const deadline = this.now() + this.tunnelStartupTimeoutMs;
    while (this.now() < deadline) {
      const latest = extractLatestUrl(this.tunnelLog, provider);
      if (latest) {
        return latest;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new PublicAccessError(
      provider === "localhost-run"
        ? "localhost.run did not publish a *.lhr.life URL. Inspect tunnel logs and retry."
        : "cloudflared did not publish a trycloudflare.com URL. Inspect tunnel logs and retry.",
      502
    );
  }

  private async requireHealthy(baseUrl: string): Promise<void> {
    const healthUrl = new URL("/health", baseUrl).toString();
    const response = await this.fetch(healthUrl, {
      signal: AbortSignal.timeout(this.healthTimeoutMs),
    });
    if (!response.ok) {
      throw new PublicAccessError(`Public health check failed with HTTP ${response.status}.`, 502);
    }
    const payload = (await response.json().catch(() => null)) as { ok?: unknown } | null;
    if (!payload || payload.ok !== true) {
      throw new PublicAccessError("Public health check did not return the Cesium health payload.", 502);
    }
  }

  private startTimers(): void {
    this.heartbeatTimer = setInterval(() => {
      void this.publishRendezvous().catch((error) => {
        this.lastRendezvousError = error instanceof Error ? error.message : String(error);
      });
    }, this.heartbeatIntervalMs);
    this.healthTimer = setInterval(() => {
      void this.checkPublicHealth();
    }, this.healthIntervalMs);
    this.heartbeatTimer.unref?.();
    this.healthTimer.unref?.();
  }

  private stopTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.heartbeatTimer = null;
    this.healthTimer = null;
    this.restartTimer = null;
  }

  private async checkPublicHealth(): Promise<void> {
    if (!this.config?.enabled || !this.currentPublicUrl) return;
    try {
      await this.requireHealthy(this.currentPublicUrl);
      this.healthFailures = 0;
    } catch (error) {
      this.healthFailures += 1;
      this.lastTunnelError = error instanceof Error ? error.message : String(error);
      if (this.healthFailures >= 3 && !this.config.customPublicUrl) {
        this.healthFailures = 0;
        await this.stopOwnedChild();
        this.scheduleRestart();
      }
    }
  }

  private scheduleRestart(): void {
    if (this.restartTimer || !this.config?.enabled) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.config?.enabled) return;
      void this.startExposure(this.config).catch((error) => {
        this.lastTunnelError = error instanceof Error ? error.message : String(error);
      });
    }, this.restartDelayMs);
    this.restartTimer.unref?.();
  }

  private async stopOwnedChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stoppingChild = true;
    this.child = null;
    let exited = false;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!exited) {
          child.kill("SIGKILL");
        }
        resolve();
      }, 1500);
      timer.unref?.();
      child.on("exit", () => {
        exited = true;
        clearTimeout(timer);
        resolve();
      });
    });
    this.stoppingChild = false;
  }

  private async publishRendezvous(): Promise<void> {
    if (!this.config?.enabled || !this.currentPublicUrl || !this.activeProvider) return;
    const config = this.config;
    const endpoint = new URL(`/api/rendezvous/${encodeURIComponent(config.serverId)}`, config.webAppUrl);
    const response = await this.fetch(endpoint.toString(), {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${config.rendezvousWriteSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: 1,
        ciphertext: this.encryptedRecord(config, this.currentPublicUrl, this.activeProvider),
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch((error) => {
      this.lastRendezvousError =
        error instanceof Error ? error.message : "Rendezvous publish failed.";
      throw new PublicAccessError(
        this.lastRendezvousError,
        502
      );
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
      this.lastRendezvousError =
        typeof payload?.error === "string"
          ? payload.error
          : `Rendezvous publish failed (${response.status}).`;
      throw new PublicAccessError(this.lastRendezvousError, 502);
    }
    this.lastRendezvousError = null;
    this.lastPublishedAt = this.now();
    await this.writeRendezvousStatusFile();
  }

  private encryptedRecord(config: PublicAccessConfig, publicUrl: string, provider: string): string {
    const endpoint = new URL(publicUrl);
    if (endpoint.protocol !== "https:") {
      throw new PublicAccessError("Published Cesium endpoint must use HTTPS.");
    }
    endpoint.username = "";
    endpoint.password = "";
    endpoint.hash = "";
    const plaintext = Buffer.from(
      JSON.stringify({
        baseUrl: endpoint.toString().replace(/\/+$/, ""),
        issuedAt: this.now(),
        label: config.label || undefined,
        tunnelProvider: provider || undefined,
      })
    );
    const key = createHash("sha256")
      .update(`cesium-rendezvous-v1\0${config.rendezvousReadSecret}`)
      .digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(config.serverId));
    const encrypted = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return `${iv.toString("base64url")}.${encrypted.toString("base64url")}`;
  }

  private buildConnectUrl(config: PublicAccessConfig, publicUrl: string): string {
    const payload = {
      version: 1,
      serverId: config.serverId,
      secret: config.rendezvousReadSecret,
      registryBaseUrl: new URL(config.webAppUrl).origin,
      initialBaseUrl: new URL(publicUrl).toString().replace(/\/+$/, ""),
      label: config.label || undefined,
    };
    const fragment = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${new URL(config.webAppUrl).origin}/agent#cesiumConnect=${fragment}`;
  }

  private status(): PublicAccessStatus {
    const config = this.config;
    const publicUrl = this.currentPublicUrl;
    const connectUrl = config && publicUrl ? this.buildConnectUrl(config, publicUrl) : null;
    const authUsername = process.env.OPENCURSOR_AUTH_USERNAME?.trim() || config?.managedAuthUsername || null;
    const externalAuth =
      Boolean(this.initialEnvAuthUsername && this.initialEnvAuthPassword) &&
      !this.runtimeAuthOwnedByManager;
    return {
      configured: Boolean(config),
      enabled: config?.enabled === true,
      webAppUrl: config?.webAppUrl ?? null,
      webAppOrigin: config ? new URL(config.webAppUrl).origin : null,
      provider: config?.customPublicUrl ? "custom" : config?.provider ?? null,
      customPublicUrl: config?.customPublicUrl ?? null,
      serverId: config?.serverId ?? null,
      label: config?.label ?? null,
      publicUrl,
      connectUrl,
      auth: {
        enabled: isAuthEnabled(),
        username: authUsername,
        credentialsManagerGenerated: config?.credentialsManagerGenerated === true,
        managedRuntimeCredentials: this.runtimeAuthOwnedByManager,
        externallyConfigured: externalAuth,
      },
      tunnel: {
        running: Boolean(this.child && !this.child.killed) || this.activeProvider === "custom",
        provider: this.activeProvider,
        pid: this.child?.pid ?? null,
        healthFailures: this.healthFailures,
        lastError: this.lastTunnelError,
      },
      rendezvous: {
        registryOrigin: config ? new URL(config.webAppUrl).origin : null,
        lastPublishedAt: this.lastPublishedAt,
        lastError: this.lastRendezvousError,
      },
    };
  }

  private async writePublicUrlFile(publicUrl: string): Promise<void> {
    if (!this.runDir) return;
    await fs.mkdir(this.runDir, { recursive: true });
    await fs.writeFile(path.join(this.runDir, "public-url"), `${publicUrl}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  private async writeRendezvousStatusFile(): Promise<void> {
    if (!this.runDir || !this.currentPublicUrl || !this.lastPublishedAt) return;
    await fs.mkdir(this.runDir, { recursive: true });
    const seconds = Math.floor(this.lastPublishedAt / 1000);
    await fs.writeFile(
      path.join(this.runDir, "rendezvous-status"),
      `${seconds}\t${this.currentPublicUrl}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  }

  private async clearRunStatusFiles(): Promise<void> {
    if (!this.runDir) return;
    await fs.rm(path.join(this.runDir, "public-url"), { force: true }).catch(() => undefined);
    await fs.rm(path.join(this.runDir, "rendezvous-status"), { force: true }).catch(() => undefined);
  }

  private async writeDisabledMarker(disabled: boolean): Promise<void> {
    if (!this.runDir) return;
    const marker = path.join(this.runDir, "backend-public-access-disabled");
    if (!disabled) {
      await fs.rm(marker, { force: true }).catch(() => undefined);
      return;
    }
    await fs.mkdir(this.runDir, { recursive: true });
    await fs.writeFile(marker, "disabled\n", { encoding: "utf8", mode: 0o600 });
  }

  private registerCleanupHandlers(): void {
    if (this.signalsRegistered || process.env.NODE_ENV === "test") return;
    this.signalsRegistered = true;
    process.once("SIGINT", () => {
      void this.stopRuntimeOnly().finally(() => process.exit(130));
    });
    process.once("SIGTERM", () => {
      void this.stopRuntimeOnly().finally(() => process.exit(143));
    });
    process.once("beforeExit", () => {
      const child = this.child;
      if (child && !child.killed) {
        child.kill("SIGTERM");
      }
    });
  }

  private get configFilePath(): string {
    return this.deps.configFilePath ?? CONFIG_FILE;
  }

  private get runDir(): string | null {
    if (this.deps.runDir !== undefined) return this.deps.runDir;
    const home = process.env.CESIUM_HOME?.trim();
    return home ? path.join(home, "run") : null;
  }

  private get localHost(): string {
    const host = this.deps.host ?? process.env.HOST?.trim() ?? "127.0.0.1";
    return host === "0.0.0.0" ? "127.0.0.1" : host;
  }

  private get localPort(): number {
    return this.deps.port ?? Number.parseInt(process.env.PORT ?? "9100", 10);
  }

  private get fetch(): typeof fetch {
    return this.deps.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private get spawn(): NonNullable<PublicAccessManagerDeps["spawn"]> {
    return (
      this.deps.spawn ??
      ((command, args, options) => nodeSpawn(command, args, options) as PublicAccessChild)
    );
  }

  private get findExecutable(): NonNullable<PublicAccessManagerDeps["findExecutable"]> {
    return this.deps.findExecutable ?? defaultFindExecutable;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private get healthTimeoutMs(): number {
    return this.deps.healthTimeoutMs ?? 5000;
  }

  private get tunnelStartupTimeoutMs(): number {
    return this.deps.tunnelStartupTimeoutMs ?? 30_000;
  }

  private get heartbeatIntervalMs(): number {
    return this.deps.heartbeatIntervalMs ?? 15_000;
  }

  private get healthIntervalMs(): number {
    return this.deps.healthIntervalMs ?? 5000;
  }

  private get restartDelayMs(): number {
    return this.deps.restartDelayMs ?? 2000;
  }
}

export const publicAccessManager = new PublicAccessManager();

export function createPublicAccessManagerForTests(
  deps: PublicAccessManagerDeps
): PublicAccessManager {
  return new PublicAccessManager({ ...deps, registerSignals: false });
}

export async function startPublicAccessManager(): Promise<void> {
  await publicAccessManager.start();
}

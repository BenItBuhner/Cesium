import { readdirSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AcpJsonRpcError } from "./acp-transport.js";
import { harnessHomeDirCandidates } from "./harness-runtime.js";
import type { AgentConfigOption, AgentConfigOptionValue } from "./types.js";

/**
 * Google's official Antigravity ACP server (`agy_acp_server`), published to
 * the ACP Registry as `antigravity-acp` and downloaded from `dl.google.com`.
 *
 * Unlike the legacy `agy` terminal bridge, this is a real Agent Client
 * Protocol stdio server: Google owns authentication (OAuth / API key), the
 * harness core (`localharness_external`), permissions, and session storage.
 * Cesium is a plain ACP client, exactly like Zed, JetBrains, or Xcode.
 *
 * Everything backend-specific that the generic ACP stack needs - auth method
 * ids, the `$GEMINI_HOME/antigravity-acp` state layout, env bootstrap, the
 * recorded `session/new` contract used as a seed, and error classifiers - is
 * kept here so `providers.ts`, `acp-session.ts`, `harness-cli-auth.ts`, and
 * the installer never re-derive it.
 */

export const GOOGLE_ANTIGRAVITY_ACP_BACKEND_ID = "google-antigravity-acp" as const;

/** ACP Registry id (`agentclientprotocol/registry/antigravity-acp/agent.json`). */
export const ANTIGRAVITY_ACP_REGISTRY_ID = "antigravity-acp";

/** Directory under `$GEMINI_HOME` that the server owns. */
export const ANTIGRAVITY_ACP_STATE_DIRNAME = "antigravity-acp";

export type AntigravityAcpAuthMethodId =
  | "oauth-personal"
  | "oauth-business"
  | "gemini-api-key"
  | "agent-platform";

export type AntigravityAcpAuthMethod = {
  id: AntigravityAcpAuthMethodId;
  name: string;
  description: string;
  /** Method needs `gcp.project` + `gcp.location` in settings.json. */
  requiresGcp: boolean;
  /** Method reads an API key from this env var in the server's spawn env. */
  apiKeyEnvVar: string | null;
  /** Method opens a Google sign-in URL that must be completed in a browser. */
  browserLogin: boolean;
};

/**
 * Advertised by `initialize` (`authMethods`) on `agy_acp_server_1.1.1`. The
 * ids are Google's; names/descriptions mirror the server's own strings.
 */
export const ANTIGRAVITY_ACP_AUTH_METHODS: readonly AntigravityAcpAuthMethod[] = [
  {
    id: "oauth-personal",
    name: "Log in with Google",
    description: "Log in with your Google account (Antigravity Free, Pro, or Ultra plan).",
    requiresGcp: false,
    apiKeyEnvVar: null,
    browserLogin: true,
  },
  {
    id: "oauth-business",
    name: "Log in with Gemini Enterprise",
    description:
      "Log in with your Gemini Enterprise account. Requires a GCP project and location.",
    requiresGcp: true,
    apiKeyEnvVar: null,
    browserLogin: true,
  },
  {
    id: "gemini-api-key",
    name: "Gemini API key",
    description: "Use an API key with the Gemini Developer API (GEMINI_API_KEY).",
    requiresGcp: false,
    apiKeyEnvVar: "GEMINI_API_KEY",
    browserLogin: false,
  },
  {
    id: "agent-platform",
    name: "Gemini Enterprise Agent Platform",
    description:
      "Use Gemini Enterprise Agent Platform (formerly Vertex AI) with Application Default Credentials or GOOGLE_API_KEY.",
    requiresGcp: true,
    apiKeyEnvVar: "GOOGLE_API_KEY",
    browserLogin: false,
  },
];

export const ANTIGRAVITY_ACP_DEFAULT_AUTH_METHOD: AntigravityAcpAuthMethodId = "oauth-personal";

export function isAntigravityAcpAuthMethodId(value: unknown): value is AntigravityAcpAuthMethodId {
  return ANTIGRAVITY_ACP_AUTH_METHODS.some((method) => method.id === value);
}

export function antigravityAcpAuthMethod(
  id: AntigravityAcpAuthMethodId
): AntigravityAcpAuthMethod {
  return ANTIGRAVITY_ACP_AUTH_METHODS.find((method) => method.id === id)!;
}

/**
 * The server resolves its home from `$GEMINI_HOME` (default `~/.gemini`) and
 * pins every session to it (`session/resume` for a foreign home fails with
 * `-32002 Session not found in the current GEMINI_HOME`). Cesium keeps the
 * default so a sign-in done in Zed/JetBrains on the same machine is shared;
 * `OPENCURSOR_ANTIGRAVITY_ACP_HOME` isolates Cesium when that is undesirable.
 */
export function resolveAntigravityAcpGeminiHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCURSOR_ANTIGRAVITY_ACP_HOME?.trim();
  if (override) {
    return path.resolve(override);
  }
  const geminiHome = env.GEMINI_HOME?.trim();
  if (geminiHome) {
    return path.resolve(geminiHome);
  }
  const home = harnessHomeDirCandidates()[0] ?? os.homedir();
  return path.join(home, ".gemini");
}

export function antigravityAcpStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveAntigravityAcpGeminiHome(env), ANTIGRAVITY_ACP_STATE_DIRNAME);
}

export function antigravityAcpSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(antigravityAcpStateDir(env), "settings.json");
}

export function antigravityAcpConversationsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(antigravityAcpStateDir(env), "conversations");
}

export type AntigravityAcpSettings = {
  auth?: { type?: string };
  gcp?: { project?: string; location?: string };
  [key: string]: unknown;
};

export async function readAntigravityAcpSettings(
  env: NodeJS.ProcessEnv = process.env
): Promise<AntigravityAcpSettings | null> {
  try {
    const raw = await fs.readFile(antigravityAcpSettingsPath(env), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as AntigravityAcpSettings;
  } catch {
    return null;
  }
}

/**
 * Merge-writes `settings.json`. Only `auth.type` and `gcp.*` are ever
 * touched by Cesium; unknown keys the server wrote are preserved verbatim.
 */
export async function writeAntigravityAcpSettings(
  patch: {
    authType?: AntigravityAcpAuthMethodId | null;
    gcpProject?: string | null;
    gcpLocation?: string | null;
  },
  env: NodeJS.ProcessEnv = process.env
): Promise<AntigravityAcpSettings> {
  const current = (await readAntigravityAcpSettings(env)) ?? {};
  const next: AntigravityAcpSettings = { ...current };
  if (patch.authType !== undefined) {
    if (patch.authType === null) {
      delete next.auth;
    } else {
      next.auth = { ...(current.auth ?? {}), type: patch.authType };
    }
  }
  if (patch.gcpProject !== undefined || patch.gcpLocation !== undefined) {
    const gcp: { project?: string; location?: string } = { ...(current.gcp ?? {}) };
    if (patch.gcpProject !== undefined) {
      if (patch.gcpProject && patch.gcpProject.trim()) {
        gcp.project = patch.gcpProject.trim();
      } else {
        delete gcp.project;
      }
    }
    if (patch.gcpLocation !== undefined) {
      if (patch.gcpLocation && patch.gcpLocation.trim()) {
        gcp.location = patch.gcpLocation.trim();
      } else {
        delete gcp.location;
      }
    }
    if (Object.keys(gcp).length > 0) {
      next.gcp = gcp;
    } else {
      delete next.gcp;
    }
  }
  const settingsPath = antigravityAcpSettingsPath(env);
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/**
 * Home-relative credential paths for harness auth sync / sign-in detection.
 * Only meaningful when `GEMINI_HOME` is the default `~/.gemini`; the server
 * names its OAuth credential file itself, so several candidates are listed
 * and only existing files are ever read.
 */
export function antigravityAcpCredentialRelPaths(): string[][] {
  return [
    [".gemini", ANTIGRAVITY_ACP_STATE_DIRNAME, "settings.json"],
    [".gemini", ANTIGRAVITY_ACP_STATE_DIRNAME, "oauth_creds.json"],
    [".gemini", ANTIGRAVITY_ACP_STATE_DIRNAME, "credentials.json"],
    [".gemini", ANTIGRAVITY_ACP_STATE_DIRNAME, "google_accounts.json"],
  ];
}

/** Gemini Developer API key from the environment (`GEMINI_API_KEY` wins). */
export function resolveGeminiApiKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const direct = env.GEMINI_API_KEY?.trim();
  if (direct) {
    return direct;
  }
  const google = env.GOOGLE_API_KEY?.trim();
  return google || null;
}

/**
 * API key for the `gemini-api-key` method: process env first, then the Google
 * provider key stored under Settings -> Agents -> Cesium Agent, so a user who
 * already configured Gemini for the first-party harness needs no extra step.
 */
export async function resolveAntigravityAcpApiKey(
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  const fromEnv = resolveGeminiApiKeyFromEnv(env);
  if (fromEnv) {
    return fromEnv;
  }
  try {
    const { getCesiumAgentSettings } = await import("../cesium-agent-settings.js");
    const settings = await getCesiumAgentSettings();
    const stored = settings.providerKeys.find(
      (key) => key.providerId.trim().toLowerCase() === "google" && key.apiKey.trim()
    );
    return stored?.apiKey.trim() ?? null;
  } catch {
    return null;
  }
}

export type AntigravityAcpCredentialState = {
  /** `auth.type` recorded in settings.json, if any. */
  configuredAuthType: AntigravityAcpAuthMethodId | null;
  /** Files other than settings.json/conversations exist in the state dir. */
  hasCredentialFiles: boolean;
  /** A Gemini API key is resolvable for the `gemini-api-key` method. */
  apiKeyAvailable: boolean;
  /** GCP project + location are configured (enterprise methods). */
  gcpConfigured: boolean;
  /**
   * Best-effort sign-in verdict. `null` means "configured but unverified";
   * the authoritative check is a `session/new` that does not return -32000.
   */
  signedIn: boolean | null;
  settingsPath: string;
  geminiHome: string;
};

function listStateDirCredentialFiles(stateDir: string): string[] {
  try {
    return readdirSync(stateDir).filter((name) => {
      if (name === "settings.json" || name === "conversations") {
        return false;
      }
      try {
        return statSync(path.join(stateDir, name)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

export async function detectAntigravityAcpCredentialState(
  env: NodeJS.ProcessEnv = process.env
): Promise<AntigravityAcpCredentialState> {
  const geminiHome = resolveAntigravityAcpGeminiHome(env);
  const stateDir = antigravityAcpStateDir(env);
  const settings = await readAntigravityAcpSettings(env);
  const rawType = settings?.auth?.type;
  const configuredAuthType = isAntigravityAcpAuthMethodId(rawType) ? rawType : null;
  const hasCredentialFiles = listStateDirCredentialFiles(stateDir).length > 0;
  const apiKeyAvailable = (await resolveAntigravityAcpApiKey(env)) !== null;
  const gcpConfigured = Boolean(
    (settings?.gcp?.project?.trim() ||
      env.GOOGLE_CLOUD_PROJECT?.trim()) &&
      (settings?.gcp?.location?.trim() || env.GOOGLE_CLOUD_LOCATION?.trim())
  );

  let signedIn: boolean | null;
  switch (configuredAuthType) {
    case null:
      signedIn = false;
      break;
    case "gemini-api-key":
      signedIn = apiKeyAvailable;
      break;
    case "agent-platform":
      signedIn = Boolean(env.GOOGLE_API_KEY?.trim()) || gcpConfigured ? true : null;
      break;
    case "oauth-personal":
    case "oauth-business":
      signedIn = hasCredentialFiles ? true : null;
      break;
  }

  return {
    configuredAuthType,
    hasCredentialFiles,
    apiKeyAvailable,
    gcpConfigured,
    signedIn,
    settingsPath: antigravityAcpSettingsPath(env),
    geminiHome,
  };
}

export function describeAntigravityAcpAuthStatus(state: AntigravityAcpCredentialState): string {
  if (!state.configuredAuthType) {
    return "not signed in";
  }
  const method = antigravityAcpAuthMethod(state.configuredAuthType);
  if (state.signedIn === true) {
    return `signed in via ${method.name}`;
  }
  if (state.signedIn === null) {
    return `${method.name} configured (unverified)`;
  }
  return `${method.name} selected but incomplete`;
}

/**
 * Environment for spawning the server. `GEMINI_HOME` is only injected when
 * Cesium overrides it (so the default `~/.gemini` stays shared), and a Gemini
 * API key is injected when one is resolvable and the process env lacks it.
 */
export async function buildAntigravityAcpSpawnEnv(
  base: NodeJS.ProcessEnv = process.env
): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...base };
  const override = base.OPENCURSOR_ANTIGRAVITY_ACP_HOME?.trim();
  if (override) {
    env.GEMINI_HOME = path.resolve(override);
  }
  if (!env.GEMINI_API_KEY?.trim()) {
    const apiKey = await resolveAntigravityAcpApiKey(base);
    if (apiKey) {
      env.GEMINI_API_KEY = apiKey;
    }
  }
  return env;
}

/**
 * Parses the server's version from its `--version` banner or `agentInfo.version`
 * (`agy_acp_server_1.1.1`, `agy_acp_server_20260818_01_RC01`). The banner also
 * contains unrelated dotted numbers (changelists, Python version), so the
 * generic `\d+\.\d+` probe cannot be used.
 */
export function parseAntigravityAcpVersion(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const semver = /agy_acp_server[_-]v?(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z]+)*)/.exec(raw);
  if (semver?.[1]) {
    return semver[1];
  }
  const rc = /agy_acp_server[_-](\d{8}_\d+_RC\d+)/.exec(raw);
  return rc?.[1] ?? null;
}
/** stderr line the server prints when `authenticate` needs a browser. */
const SIGN_IN_URL_RE =
  /Open the following link to authenticate the ACP server:\s*(https?:\/\/[^\s"'<>]+)/i;

export function extractAntigravityAcpSignInUrl(text: string): string | null {
  const match = SIGN_IN_URL_RE.exec(text);
  return match?.[1] ?? null;
}

/** `session/new` (and friends) before `authenticate`: `-32000 Authentication required`. */
export function isAntigravityAcpAuthRequiredError(error: unknown): boolean {
  if (error instanceof AcpJsonRpcError) {
    return error.code === -32000 || /authentication required/i.test(error.message);
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /authentication required/i.test(message);
}

/** `session/load|resume` for an id outside the current `GEMINI_HOME`. */
export function isAntigravityAcpSessionNotFoundError(error: unknown): boolean {
  if (error instanceof AcpJsonRpcError) {
    return error.code === -32002 || /session not found/i.test(error.message);
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /session not found/i.test(message);
}

/**
 * The server reports turn failures (bad key, quota, backend outage) as a
 * final `agent_message_chunk` rather than a JSON-RPC error, e.g.
 * `Agent execution error: Agent execution terminated due to error. ("request failed (code 400): API key not valid. ...")`.
 */
export const ANTIGRAVITY_ACP_EXECUTION_ERROR_PREFIX = "Agent execution error:";

export function extractAcpAgentExecutionError(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(ANTIGRAVITY_ACP_EXECUTION_ERROR_PREFIX)) {
    return null;
  }
  const detail = trimmed.slice(ANTIGRAVITY_ACP_EXECUTION_ERROR_PREFIX.length).trim();
  return detail || trimmed;
}

export type AntigravityAcpModeId = "default" | "auto_edit" | "yolo";

/** Permission policies exposed as ACP session modes by the server. */
export const ANTIGRAVITY_ACP_MODES: ReadonlyArray<{
  id: AntigravityAcpModeId;
  name: string;
  description: string;
}> = [
  { id: "default", name: "Default", description: "Default permission prompt flow" },
  { id: "auto_edit", name: "Auto Edit", description: "Auto-approve file edit tools" },
  { id: "yolo", name: "YOLO", description: "Auto-approve all tools" },
];

export const ANTIGRAVITY_ACP_DEFAULT_MODEL_ID = "gemini-3.7-flash-high";

/**
 * Model ids returned by `session/new` on `agy_acp_server_1.1.1`. Thinking
 * level is baked into the id. Used only as a seed for the model picker before
 * the first session; live `configOptions` from the server always win.
 */
export const ANTIGRAVITY_ACP_MODEL_CATALOG: readonly AgentConfigOptionValue[] = [
  { value: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)", description: "Gemini 3.7 Flash model with high thinking level" },
  { value: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)", description: "Gemini 3.7 Flash model with medium thinking level" },
  { value: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)", description: "Gemini 3.7 Flash model with low thinking level" },
  { value: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)", description: "Gemini 3.6 Flash model with high thinking level" },
  { value: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (Medium)", description: "Gemini 3.6 Flash model with medium thinking level" },
  { value: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash (Low)", description: "Gemini 3.6 Flash model with low thinking level" },
  { value: "gemini-3.5-flash-high", name: "Gemini 3.5 Flash (High)", description: "Gemini 3.5 Flash model with high thinking level" },
  { value: "gemini-3.5-flash-medium", name: "Gemini 3.5 Flash (Medium)", description: "Gemini 3.5 Flash model with medium thinking level" },
  { value: "gemini-3.5-flash-low", name: "Gemini 3.5 Flash (Low)", description: "Gemini 3.5 Flash model with low thinking level" },
  { value: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)", description: "Gemini 3.1 Pro model with high thinking level" },
  { value: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)", description: "Gemini 3.1 Pro model with low thinking level" },
];

export function createGoogleAntigravityAcpConfigOptions(): AgentConfigOption[] {
  return [
    {
      id: "mode",
      name: "Session Mode",
      category: "mode",
      currentValue: "default",
      description:
        "Antigravity permission policy. Default asks before tools run; Auto Edit approves file edits; YOLO approves everything.",
      options: ANTIGRAVITY_ACP_MODES.map((mode) => ({
        value: mode.id,
        name: mode.name,
        description: mode.description,
      })),
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      currentValue: ANTIGRAVITY_ACP_DEFAULT_MODEL_ID,
      description: "Seeded from the official Antigravity ACP server catalog; the live session list replaces it.",
      options: [...ANTIGRAVITY_ACP_MODEL_CATALOG],
    },
  ];
}

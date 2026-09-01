"use node";

import { v } from "convex/values";
import sodium from "libsodium-wrappers";
import { action } from "./_generated/server";
import {
  createGithubClient,
  createCodespace,
  createPullRequest,
  commitFiles,
  deleteCodespace,
  findOpenPullRequest,
  getAuthenticatedLogin,
  getCodespace,
  getCodespacesPublicKey,
  getDefaultBranch,
  getRepoFile,
  listMachines,
  listRepos,
  putUserCodespaceSecret,
  splitRepoFullName,
  startCodespace,
  stopCodespace,
  type GithubClient,
} from "./lib/githubApi";
import {
  extractClerkApiErrorMessage,
  readClerkGithubOauthToken,
} from "./lib/clerkGithub";
import {
  buildCodespaceTemplateFiles,
  resolveCodespaceEngineBaseUrl,
  CODESPACE_AUTH_PASSWORD_SECRET,
  CODESPACE_AUTH_USERNAME_SECRET,
  CODESPACE_BOOTSTRAP_PATH,
  CODESPACE_DEVCONTAINER_PATH,
  CODESPACE_TEMPLATE_VERSION,
} from "./lib/codespaceBootstrap";

/**
 * GitHub Codespaces device integration - server-side GitHub proxy.
 *
 * Tokens never reach Cesium clients. Two identity paths, mirroring
 * `convex/lib/identity.ts`:
 *
 * - **Clerk accounts** (production): the user's GitHub OAuth token comes from
 *   Clerk's connected-accounts backend API (`CLERK_SECRET_KEY` must be set on
 *   this deployment). Clerk dashboard prerequisites (one-time): create a
 *   GitHub OAuth App whose Authorization callback URL is Clerk's
 *   `…/v1/oauth_callback`, paste Client ID + Client Secret into SSO
 *   connections → GitHub, add scopes `read:user user:email repo codespace`,
 *   then **Enable connection**. "Enable for sign-up and sign-in" can stay
 *   off — linking after email sign-in is enough. Production Clerk instances
 *   require those custom credentials; shared Clerk credentials cannot
 *   request `repo` / `codespace`.
 * - **Device-key accounts** (self-hosted / local-first deployments that opt
 *   in with `CESIUM_ALLOW_DEVICE_KEYS=1`): a deployment-level token from the
 *   `CESIUM_GITHUB_TOKEN` env var (classic PAT or OAuth token with `repo` +
 *   `codespace` scopes). Single-operator deployments only - every device key
 *   on the deployment shares it.
 *
 * Deployment env overrides:
 * - `CESIUM_GITHUB_API_URL` - GitHub Enterprise API host (default
 *   https://api.github.com).
 * - `CESIUM_CODESPACES_PORT_FORWARDING_DOMAIN` /
 *   `CESIUM_CODESPACES_ENGINE_URL_TEMPLATE` - forwarded-port URL shape (see
 *   `resolveCodespaceEngineBaseUrl`).
 */

const CLERK_API_BASE = "https://api.clerk.com/v1";
const SETUP_BRANCH = "cesium/codespace-setup";

/** Codespaces secret names must be SCREAMING_SNAKE and never GITHUB_*. */
const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,199}$/;

const DEVICE_KEY_PATTERN = /^[A-Za-z0-9-]{16,64}$/;

type ActionAuthCtx = {
  auth: { getUserIdentity(): Promise<{ subject: string } | null> };
};

type GithubIdentity =
  | { kind: "clerk"; subject: string }
  | { kind: "device"; deviceKey: string };

async function resolveGithubIdentity(
  ctx: ActionAuthCtx,
  deviceKey: string | undefined
): Promise<GithubIdentity> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity) {
    return { kind: "clerk", subject: identity.subject };
  }
  if (
    deviceKey &&
    process.env.CESIUM_ALLOW_DEVICE_KEYS === "1" &&
    DEVICE_KEY_PATTERN.test(deviceKey)
  ) {
    return { kind: "device", deviceKey };
  }
  throw new Error("GitHub integration requires a signed-in Cesium account.");
}

async function getClerkGithubToken(subject: string): Promise<string | null> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new Error(
      "CLERK_SECRET_KEY is not configured on this Convex deployment."
    );
  }
  const response = await fetch(
    `${CLERK_API_BASE}/users/${encodeURIComponent(subject)}/oauth_access_tokens/oauth_github?limit=1`,
    { headers: { Authorization: `Bearer ${secretKey}` } }
  );
  if (response.status === 404) {
    return null;
  }
  const payload = (await response.json()) as unknown;
  if (!response.ok) {
    const detail = extractClerkApiErrorMessage(payload);
    throw new Error(
      detail
        ? `Could not fetch the GitHub token from Clerk (${response.status}): ${detail}`
        : `Could not fetch the GitHub token from Clerk (${response.status}).`
    );
  }
  return readClerkGithubOauthToken(payload);
}

async function getGithubToken(identity: GithubIdentity): Promise<string | null> {
  if (identity.kind === "device") {
    return process.env.CESIUM_GITHUB_TOKEN?.trim() || null;
  }
  return await getClerkGithubToken(identity.subject);
}

function githubApiBaseUrl(): string | undefined {
  return process.env.CESIUM_GITHUB_API_URL?.trim() || undefined;
}

function noConnectionMessage(identity: GithubIdentity): string {
  return identity.kind === "device"
    ? "No GitHub token is configured. Set CESIUM_GITHUB_TOKEN on this Convex deployment (repo + codespace scopes)."
    : "No GitHub account is connected to this Cesium account. Connect GitHub in Settings -> Account first.";
}

async function requireGithubClient(
  ctx: ActionAuthCtx,
  deviceKey: string | undefined
): Promise<GithubClient> {
  const identity = await resolveGithubIdentity(ctx, deviceKey);
  const token = await getGithubToken(identity);
  if (!token) {
    throw new Error(noConnectionMessage(identity));
  }
  return createGithubClient(token, undefined, githubApiBaseUrl());
}

const codespaceValidator = v.object({
  name: v.string(),
  displayName: v.union(v.string(), v.null()),
  state: v.string(),
  repositoryFullName: v.union(v.string(), v.null()),
  machine: v.union(v.string(), v.null()),
  gitRef: v.union(v.string(), v.null()),
  lastUsedAt: v.union(v.string(), v.null()),
  webUrl: v.union(v.string(), v.null()),
  idleTimeoutMinutes: v.union(v.number(), v.null()),
  retentionExpiresAt: v.union(v.string(), v.null()),
});

/** Whether this account has a usable GitHub connection (and who it is). */
export const connectionStatus = action({
  args: { deviceKey: v.optional(v.string()) },
  returns: v.object({
    connected: v.boolean(),
    login: v.union(v.string(), v.null()),
    error: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    try {
      const identity = await resolveGithubIdentity(ctx, args.deviceKey);
      const token = await getGithubToken(identity);
      if (!token) {
        return { connected: false, login: null, error: null };
      }
      const login = await getAuthenticatedLogin(
        createGithubClient(token, undefined, githubApiBaseUrl())
      );
      return { connected: true, login, error: null };
    } catch (error) {
      return {
        connected: false,
        login: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

export const reposList = action({
  args: { deviceKey: v.optional(v.string()) },
  returns: v.array(
    v.object({
      id: v.number(),
      fullName: v.string(),
      private: v.boolean(),
      defaultBranch: v.string(),
      pushedAt: v.union(v.string(), v.null()),
      description: v.union(v.string(), v.null()),
    })
  ),
  handler: async (ctx, args) => {
    const client = await requireGithubClient(ctx, args.deviceKey);
    return await listRepos(client);
  },
});

export const machinesList = action({
  args: { deviceKey: v.optional(v.string()), repoFullName: v.string() },
  returns: v.array(
    v.object({
      name: v.string(),
      displayName: v.string(),
      cpus: v.number(),
      memoryInBytes: v.number(),
      storageInBytes: v.number(),
      prebuildAvailability: v.union(v.string(), v.null()),
    })
  ),
  handler: async (ctx, args) => {
    const client = await requireGithubClient(ctx, args.deviceKey);
    const { owner, repo } = splitRepoFullName(args.repoFullName);
    return await listMachines(client, owner, repo);
  },
});

/**
 * Make sure the Cesium devcontainer assets exist (and are current) in the
 * repository. `mode: "commit"` pushes one commit straight to the default
 * branch; `mode: "pr"` maintains the `cesium/codespace-setup` branch and an
 * open PR. Returns what the caller must wait for before creating a
 * codespace (`ready` means the default branch already has the files).
 */
export const ensureDevcontainer = action({
  args: {
    deviceKey: v.optional(v.string()),
    repoFullName: v.string(),
    mode: v.union(v.literal("commit"), v.literal("pr")),
  },
  returns: v.object({
    status: v.union(
      v.literal("ready"),
      v.literal("committed"),
      v.literal("pr-open")
    ),
    prUrl: v.union(v.string(), v.null()),
    devcontainerPath: v.string(),
    templateVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const client = await requireGithubClient(ctx, args.deviceKey);
    const { owner, repo } = splitRepoFullName(args.repoFullName);
    const defaultBranch = await getDefaultBranch(client, owner, repo);
    const files = buildCodespaceTemplateFiles();

    const current = await Promise.all(
      files.map((file) => getRepoFile(client, owner, repo, file.path, defaultBranch))
    );
    const upToDate = files.every(
      (file, index) => current[index]?.content === file.content
    );
    if (upToDate) {
      return {
        status: "ready" as const,
        prUrl: null,
        devcontainerPath: CODESPACE_DEVCONTAINER_PATH,
        templateVersion: CODESPACE_TEMPLATE_VERSION,
      };
    }

    const isUpdate = current.some((file) => file !== null);
    const message = isUpdate
      ? `Update Cesium Codespaces engine bootstrap (template v${CODESPACE_TEMPLATE_VERSION})`
      : `Add Cesium Codespaces engine bootstrap (template v${CODESPACE_TEMPLATE_VERSION})`;
    const commitPayload = files.map((file) => ({
      path: file.path,
      content: file.content,
      executable: file.path === CODESPACE_BOOTSTRAP_PATH,
    }));

    if (args.mode === "commit") {
      await commitFiles(client, {
        owner,
        repo,
        branch: defaultBranch,
        fromBranch: defaultBranch,
        message,
        files: commitPayload,
      });
      return {
        status: "committed" as const,
        prUrl: null,
        devcontainerPath: CODESPACE_DEVCONTAINER_PATH,
        templateVersion: CODESPACE_TEMPLATE_VERSION,
      };
    }

    await commitFiles(client, {
      owner,
      repo,
      branch: SETUP_BRANCH,
      fromBranch: defaultBranch,
      message,
      files: commitPayload,
    });
    const existingPr = await findOpenPullRequest(client, owner, repo, SETUP_BRANCH);
    const pr =
      existingPr ??
      (await createPullRequest(client, {
        owner,
        repo,
        headBranch: SETUP_BRANCH,
        baseBranch: defaultBranch,
        title: "Add Cesium Codespaces engine bootstrap",
        body: [
          "Cesium uses this devcontainer to run its engine inside GitHub Codespaces:",
          "",
          `- \`${CODESPACE_DEVCONTAINER_PATH}\` - devcontainer config (port ${9100} forwarded).`,
          `- \`${CODESPACE_BOOTSTRAP_PATH}\` - installs and starts the Cesium engine, then publishes the forwarded port.`,
          "",
          "Merge this PR, then finish Codespace setup from the Cesium device picker.",
        ].join("\n"),
      }));
    return {
      status: "pr-open" as const,
      prUrl: pr.htmlUrl,
      devcontainerPath: CODESPACE_DEVCONTAINER_PATH,
      templateVersion: CODESPACE_TEMPLATE_VERSION,
    };
  },
});

/**
 * Push the engine credentials (and any optional provider API keys) as user
 * Codespaces secrets scoped to the repository. Values are sealed with the
 * account's Codespaces public key (libsodium sealed box) before upload.
 */
export const setupCodespaceSecrets = action({
  args: {
    deviceKey: v.optional(v.string()),
    repositoryId: v.number(),
    engineUsername: v.string(),
    enginePassword: v.string(),
    extraSecrets: v.optional(
      v.array(v.object({ name: v.string(), value: v.string() }))
    ),
  },
  returns: v.object({ secretNames: v.array(v.string()) }),
  handler: async (ctx, args) => {
    if (!args.engineUsername.trim() || !args.enginePassword.trim()) {
      throw new Error("Engine credentials must not be empty.");
    }
    const client = await requireGithubClient(ctx, args.deviceKey);
    const publicKey = await getCodespacesPublicKey(client);
    await sodium.ready;
    const keyBytes = sodium.from_base64(
      publicKey.key,
      sodium.base64_variants.ORIGINAL
    );
    const seal = (value: string): string =>
      sodium.to_base64(
        sodium.crypto_box_seal(sodium.from_string(value), keyBytes),
        sodium.base64_variants.ORIGINAL
      );

    const secrets: Array<{ name: string; value: string }> = [
      { name: CODESPACE_AUTH_USERNAME_SECRET, value: args.engineUsername },
      { name: CODESPACE_AUTH_PASSWORD_SECRET, value: args.enginePassword },
      ...(args.extraSecrets ?? []),
    ];
    for (const secret of secrets) {
      const name = secret.name.trim().toUpperCase();
      if (!SECRET_NAME_PATTERN.test(name) || name.startsWith("GITHUB_")) {
        throw new Error(`Invalid secret name: ${secret.name}`);
      }
      if (!secret.value) {
        throw new Error(`Secret ${name} has no value.`);
      }
      await putUserCodespaceSecret(client, {
        name,
        encryptedValue: seal(secret.value),
        keyId: publicKey.keyId,
        repositoryId: args.repositoryId,
      });
    }
    return {
      secretNames: secrets.map((secret) => secret.name.trim().toUpperCase()),
    };
  },
});

export const codespaceCreate = action({
  args: {
    deviceKey: v.optional(v.string()),
    repoFullName: v.string(),
    machine: v.optional(v.string()),
    ref: v.optional(v.string()),
    idleTimeoutMinutes: v.optional(v.number()),
  },
  returns: v.object({
    codespace: codespaceValidator,
    engineBaseUrl: v.string(),
  }),
  handler: async (ctx, args) => {
    const client = await requireGithubClient(ctx, args.deviceKey);
    const { owner, repo } = splitRepoFullName(args.repoFullName);
    const idleTimeout = args.idleTimeoutMinutes
      ? Math.min(240, Math.max(5, Math.round(args.idleTimeoutMinutes)))
      : undefined;
    const codespace = await createCodespace(client, {
      owner,
      repo,
      ...(args.ref ? { ref: args.ref } : {}),
      ...(args.machine ? { machine: args.machine } : {}),
      devcontainerPath: CODESPACE_DEVCONTAINER_PATH,
      displayName: `Cesium - ${args.repoFullName}`,
      ...(idleTimeout ? { idleTimeoutMinutes: idleTimeout } : {}),
      // Keep the paired codespace around as long as GitHub allows (30 days
      // idle); the Convex pairing survives deletion and drives recreation.
      retentionPeriodMinutes: 43200,
    });
    return {
      codespace,
      engineBaseUrl: resolveCodespaceEngineBaseUrl(codespace.name, {
        urlTemplate: process.env.CESIUM_CODESPACES_ENGINE_URL_TEMPLATE,
        portForwardingDomain: process.env.CESIUM_CODESPACES_PORT_FORWARDING_DOMAIN,
      }),
    };
  },
});

export const codespaceGet = action({
  args: { deviceKey: v.optional(v.string()), codespaceName: v.string() },
  returns: v.union(codespaceValidator, v.null()),
  handler: async (ctx, args) => {
    const client = await requireGithubClient(ctx, args.deviceKey);
    return await getCodespace(client, args.codespaceName);
  },
});

export const codespaceStart = action({
  args: { deviceKey: v.optional(v.string()), codespaceName: v.string() },
  returns: codespaceValidator,
  handler: async (ctx, args) => {
    const client = await requireGithubClient(ctx, args.deviceKey);
    return await startCodespace(client, args.codespaceName);
  },
});

export const codespaceStop = action({
  args: { deviceKey: v.optional(v.string()), codespaceName: v.string() },
  returns: codespaceValidator,
  handler: async (ctx, args) => {
    const client = await requireGithubClient(ctx, args.deviceKey);
    return await stopCodespace(client, args.codespaceName);
  },
});

export const codespaceDelete = action({
  args: { deviceKey: v.optional(v.string()), codespaceName: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const client = await requireGithubClient(ctx, args.deviceKey);
    await deleteCodespace(client, args.codespaceName);
    return null;
  },
});

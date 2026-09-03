/**
 * Pure merge rules for the `servers` table shared by the save mutation and
 * unit tests.
 *
 * The tricky case: every signed-in client periodically pushes its LOCAL
 * connection list up as plain `kind: "remote"` upserts keyed by base URL
 * (see CloudBridge). A codespace-paired row would match by base URL and get
 * flattened back to a plain remote - losing the pairing metadata that drives
 * wake/recreate. These helpers keep codespace identity sticky unless the
 * caller explicitly writes codespace metadata.
 */

export type CodespaceMeta = {
  repoFullName: string;
  repositoryId: number;
  codespaceName: string;
  displayName?: string;
  machine?: string;
  devcontainerPath: string;
  lastKnownState?: string;
  lastSyncedAt?: number;
  engineUsername?: string;
  enginePassword?: string;
};

export type ServerSaveInput = {
  name: string;
  baseUrl: string;
  kind: "remote" | "local" | "codespace";
  sessionToken?: string;
  notes?: string;
  markConnected?: boolean;
  codespace?: CodespaceMeta;
};

export type ExistingServerShape = {
  kind: "remote" | "local" | "codespace";
  codespace?: CodespaceMeta;
};

export type ServerSavePatch = {
  name: string;
  baseUrl: string;
  kind: "remote" | "local" | "codespace";
  sessionToken?: string;
  notes?: string;
  codespace?: CodespaceMeta;
};

export function buildServerSavePatch(
  existing: ExistingServerShape | null,
  input: ServerSaveInput
): ServerSavePatch {
  const incomingCodespace = input.codespace;
  const preservedCodespace =
    !incomingCodespace && existing?.kind === "codespace" && existing.codespace
      ? existing.codespace
      : undefined;
  const codespace = incomingCodespace ?? preservedCodespace;
  const kind = codespace ? "codespace" : input.kind;
  return {
    name: input.name,
    baseUrl: input.baseUrl,
    kind,
    ...(input.sessionToken !== undefined ? { sessionToken: input.sessionToken } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(codespace ? { codespace } : {}),
  };
}

/**
 * Pairing identity: a codespace row is keyed by its repository, not its base
 * URL (the URL changes when the codespace is recreated).
 */
export function findCodespaceRowIndex<
  T extends { codespace?: { repoFullName: string } | null }
>(rows: T[], repoFullName: string): number {
  return rows.findIndex(
    (row) => row.codespace?.repoFullName === repoFullName
  );
}

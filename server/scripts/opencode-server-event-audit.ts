import fs from "node:fs";
import path from "node:path";

type JsonRecord = Record<string, unknown>;

const baseUrl = process.env.OPENCURSOR_PROBE_BASE_URL ?? "http://127.0.0.1:9106";
const requestedWorkspaceRoot = path.resolve(process.env.OPENCURSOR_PROBE_WORKSPACE_ROOT ?? process.cwd());

function loadEnvFile(filePath: string): void {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator < 0) continue;
      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();
      if (
        (value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] ??= value;
    }
  } catch {
    // Optional local env files may not exist.
  }
}

loadEnvFile(path.resolve(".env"));
loadEnvFile(path.resolve(".env.local"));
loadEnvFile(path.resolve("server/.env"));
loadEnvFile(path.resolve("server/.env.local"));

async function request<T = JsonRecord>(
  pathname: string,
  init: RequestInit = {}
): Promise<{ response: Response; text: string; json: T }> {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const text = await response.text();
  return { response, text, json: (text ? JSON.parse(text) : null) as T };
}

function assertOk(result: { response: Response; text: string }, label: string): void {
  if (!result.response.ok) {
    throw new Error(`${label} failed: ${result.response.status} ${result.text.slice(0, 500)}`);
  }
}

function pickString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function eventText(event: JsonRecord): string {
  return typeof event.text === "string"
    ? event.text
    : typeof event.content === "string"
      ? event.content
      : "";
}

async function main(): Promise<void> {
  const login = await request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: process.env.OPENCURSOR_AUTH_USERNAME ?? "admin",
      password: process.env.OPENCURSOR_AUTH_PASSWORD ?? "admin",
      remember: false,
    }),
  });
  assertOk(login, "login");
  const token = login.response.headers.get("x-opencursor-session-token");
  if (!token) throw new Error("Login succeeded without a session token.");

  const authHeaders = {
    "content-type": "application/json",
    "x-opencursor-session-token": token,
  };
  const bootstrap = await request<JsonRecord>("/api/workspaces/bootstrap", {
    headers: authHeaders,
  });
  assertOk(bootstrap, "bootstrap");
  const workspaces = (bootstrap.json.workspaces as JsonRecord[] | undefined) ?? [];
  const workspace =
    workspaces.find((entry) => {
      const root = pickString(entry.root);
      return root ? path.resolve(root).toLowerCase() === requestedWorkspaceRoot.toLowerCase() : false;
    }) ?? workspaces[0];
  const workspaceId = pickString(workspace?.id);
  if (!workspaceId) throw new Error("No workspace found.");

  const headers = {
    ...authHeaders,
    "x-opencursor-workspace-id": workspaceId,
  };
  const list = await request<JsonRecord>("/api/agents/conversations?limit=200", { headers });
  assertOk(list, "list conversations");
  const conversations = ((list.json.conversations as JsonRecord[] | undefined) ?? []).filter(
    (conversation) => (conversation.config as JsonRecord | undefined)?.backendId === "opencode-server"
  );

  const reports: JsonRecord[] = [];
  for (const conversation of conversations) {
    const id = pickString(conversation.id);
    if (!id) continue;
    const full = await request<JsonRecord>(`/api/agents/conversations/${id}?full=1`, { headers });
    assertOk(full, `snapshot ${id}`);
    const snapshot = full.json.snapshot as JsonRecord;
    const record = snapshot.conversation as JsonRecord;
    const events = (snapshot.events as JsonRecord[] | undefined) ?? [];
    const users = events.filter((event) => event.kind === "user_message");
    const assistantEnds = events.filter((event) => event.kind === "assistant_message_end");
    const statuses = events.filter((event) => event.kind === "status").map((event) => event.status);
    const permissions = events.filter((event) => event.kind === "permission_request");
    const systems = events.filter((event) => event.kind === "system").map(eventText).filter(Boolean);
    const assistantMessageIds = new Set(
      events
        .filter((event) => event.kind === "assistant_message_chunk")
        .map((event) => pickString(event.messageId))
        .filter(Boolean)
    );
    const repeatedAssistantAfterIdle = events.some((event, index) => {
      if (event.kind !== "assistant_message_chunk") return false;
      return events.slice(0, index).some((prior) => prior.kind === "status" && prior.status === "idle");
    });
    const suspect =
      users.length > 1 ||
      assistantEnds.length > users.length ||
      assistantMessageIds.size > users.length ||
      permissions.length > 0 ||
      repeatedAssistantAfterIdle ||
      record.status === "running" ||
      systems.some((text) => /doom|loop|retry|free usage|abort/i.test(text));
    if (!suspect) continue;
    reports.push({
      id,
      title: record.title,
      status: record.status,
      providerSessionId: record.providerSessionId,
      model: record.config,
      counts: {
        users: users.length,
        assistantEnds: assistantEnds.length,
        assistantMessageIds: assistantMessageIds.size,
        permissions: permissions.length,
        events: events.length,
      },
      statuses,
      systems: systems.slice(-5),
      users: users.map((event) => ({
        seq: event.seq,
        eventId: event.eventId,
        messageId: event.messageId,
        createdAt: event.createdAt,
        text: eventText(event).slice(0, 500),
      })),
      tail: events.slice(-15).map((event) => ({
        seq: event.seq,
        eventId: event.eventId,
        createdAt: event.createdAt,
        kind: event.kind,
        messageId: event.messageId,
        status: event.status,
        text: eventText(event).slice(0, 180),
      })),
    });
  }

  console.log(JSON.stringify({ workspace, audited: conversations.length, suspects: reports }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});

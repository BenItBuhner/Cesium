import type {
  AgentConversationRecord,
  AgentConversationSnapshotHead,
  AgentStoredEvent,
} from "../agents/types.js";
import { agentRuntimeManager } from "../agents/runtime-manager.js";
import type { WorkspaceRecord } from "../workspace-registry.js";

/**
 * The four voice-controller tools of the first implementation slice:
 * session.list / session.inspect / session.start / session.message.
 *
 * Everything heavier (edits, tests, research, terminal work) is delegated
 * INTO Cesium conversations via session_start / session_message rather than
 * executed by the voice layer itself. Results are aggressively compacted:
 * they are LLM context for a latency-sensitive turn, not UI payloads.
 */

export type VoiceToolExecution = {
  tool: string;
  ok: boolean;
  summary: string;
  conversationId?: string;
  result: unknown;
};

type CompactConversation = {
  id: string;
  title: string;
  status: string;
  backend: string;
  updatedAt: string;
  pendingPermission: string | null;
  pendingQuestion: boolean;
  lastError: string | null;
};

function compactConversation(record: AgentConversationRecord): CompactConversation {
  return {
    id: record.id,
    title: record.title,
    status: record.status,
    backend: record.config.backendId,
    updatedAt: new Date(record.updatedAt).toISOString(),
    pendingPermission: record.pendingPermission?.title ?? null,
    pendingQuestion: Boolean(record.pendingQuestion),
    lastError: record.lastError,
  };
}

/** Reassembles the trailing assistant message from stored chunk events. */
export function lastAssistantText(events: AgentStoredEvent[]): string | null {
  let messageId: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.kind === "assistant_message_chunk") {
      messageId = event.messageId;
      break;
    }
  }
  if (!messageId) return null;
  let text = "";
  for (const event of events) {
    if (event.kind === "assistant_message_chunk" && event.messageId === messageId) {
      text += event.text;
    }
  }
  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}

function recentToolNames(events: AgentStoredEvent[], limit = 6): string[] {
  const names: string[] = [];
  for (let i = events.length - 1; i >= 0 && names.length < limit; i--) {
    const event = events[i]!;
    if (event.kind === "tool_call") {
      const name =
        (event as { title?: string; toolName?: string }).title ??
        (event as { toolName?: string }).toolName ??
        "tool";
      names.unshift(String(name));
    }
  }
  return names;
}

const CLIP = 1200;

function clipText(text: string): string {
  return text.length > CLIP ? `${text.slice(0, CLIP)}…` : text;
}

export async function executeVoiceTool(
  workspace: WorkspaceRecord,
  toolName: string,
  args: Record<string, unknown>
): Promise<VoiceToolExecution> {
  switch (toolName) {
    case "session_list": {
      const { conversations } = await agentRuntimeManager.listWorkspaceConversations(
        workspace.id,
        { limit: 30 }
      );
      const active = conversations
        .filter((record) => record.archivedAt === null)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 15)
        .map(compactConversation);
      return {
        tool: toolName,
        ok: true,
        summary: `listed ${active.length} sessions`,
        result: { sessions: active },
      };
    }

    case "session_inspect": {
      const conversationId = String(args.conversationId ?? "").trim();
      if (!conversationId) {
        return {
          tool: toolName,
          ok: false,
          summary: "missing conversationId",
          result: { error: "conversationId is required" },
        };
      }
      const snapshot: AgentConversationSnapshotHead | null =
        await agentRuntimeManager.getConversationSnapshotHead(
          workspace,
          conversationId,
          { limitEvents: 60 }
        );
      if (!snapshot) {
        return {
          tool: toolName,
          ok: false,
          summary: `unknown session ${conversationId}`,
          conversationId,
          result: { error: `Unknown conversation: ${conversationId}` },
        };
      }
      const assistantText = lastAssistantText(snapshot.events);
      return {
        tool: toolName,
        ok: true,
        summary: `inspected "${snapshot.conversation.title}" (${snapshot.conversation.status})`,
        conversationId,
        result: {
          session: compactConversation(snapshot.conversation),
          lastAssistantMessage: assistantText ? clipText(assistantText) : null,
          recentTools: recentToolNames(snapshot.events),
          pendingPermissionDetail: snapshot.conversation.pendingPermission
            ? {
                title: snapshot.conversation.pendingPermission.title ?? null,
                detail: snapshot.conversation.pendingPermission.detail ?? null,
                options: snapshot.conversation.pendingPermission.options.map(
                  (option) => option.name || option.optionId
                ),
              }
            : null,
        },
      };
    }

    case "session_start": {
      const prompt = String(args.prompt ?? "").trim();
      if (!prompt) {
        return {
          tool: toolName,
          ok: false,
          summary: "missing prompt",
          result: { error: "prompt is required" },
        };
      }
      const title = String(args.title ?? "").trim() || undefined;
      const snapshot = await agentRuntimeManager.createConversationWithPrompt(
        workspace,
        title ? { title } : {},
        { text: prompt }
      );
      return {
        tool: toolName,
        ok: true,
        summary: `started "${snapshot.conversation.title}"`,
        conversationId: snapshot.conversation.id,
        result: {
          session: compactConversation(snapshot.conversation),
        },
      };
    }

    case "session_message": {
      const conversationId = String(args.conversationId ?? "").trim();
      const text = String(args.text ?? "").trim();
      if (!conversationId || !text) {
        return {
          tool: toolName,
          ok: false,
          summary: "missing conversationId or text",
          result: { error: "conversationId and text are required" },
        };
      }
      const snapshot = await agentRuntimeManager.promptConversation(
        workspace,
        conversationId,
        text
      );
      return {
        tool: toolName,
        ok: true,
        summary: `messaged "${snapshot.conversation.title}"`,
        conversationId,
        result: {
          session: compactConversation(snapshot.conversation),
          queuedPrompts: snapshot.conversation.queuedPrompts.length,
        },
      };
    }

    default:
      return {
        tool: toolName,
        ok: false,
        summary: `unknown tool ${toolName}`,
        result: { error: `Unknown tool: ${toolName}` },
      };
  }
}

export const VOICE_TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "session_list",
      description:
        "List the agent sessions (conversations) in the current workspace with id, title, status, and pending permission/question flags.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "session_inspect",
      description:
        "Inspect one agent session: current status, the latest assistant message, recent tool activity, and any pending permission request details.",
      parameters: {
        type: "object",
        properties: {
          conversationId: {
            type: "string",
            description: "Id of the session to inspect (from session_list).",
          },
        },
        required: ["conversationId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "session_start",
      description:
        "Start a NEW agent session in the workspace and send it an initial task prompt. Returns immediately; the agent continues in the background. Use for code edits, tests, research, terminal work, or anything long-running or destructive.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Short human-readable session title (3-6 words).",
          },
          prompt: {
            type: "string",
            description:
              "Full task instructions for the delegated agent. Be specific and self-contained.",
          },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "session_message",
      description:
        "Send a follow-up prompt, answer, or steering message to an EXISTING agent session. If the session is mid-turn, the message is queued.",
      parameters: {
        type: "object",
        properties: {
          conversationId: {
            type: "string",
            description: "Id of the target session.",
          },
          text: { type: "string", description: "Message to deliver." },
        },
        required: ["conversationId", "text"],
        additionalProperties: false,
      },
    },
  },
] as const;

import type { WorkspaceRecord } from "../workspace-registry.js";
import {
  voiceControllerEnv,
  voiceControllerExtraBody,
} from "./voice-env.js";
import {
  executeVoiceTool,
  VOICE_TOOL_SCHEMAS,
  type VoiceToolExecution,
} from "./tools.js";

/**
 * The voice controller: one bounded chat-completions turn (plus a short tool
 * loop) that converts a committed utterance into a strict action object.
 * It stays deliberately small — heavy work is delegated into Cesium agent
 * sessions via session_start / session_message, which return immediately.
 */

export type VoiceHistoryEntry = {
  role: "user" | "assistant";
  content: string;
};

export type VoiceControllerRequest = {
  utterance: string;
  history?: VoiceHistoryEntry[];
  /** Voice mode at the time of the utterance; quiet mode still infers/acts. */
  mode?: "active" | "quiet";
};

export type VoiceControllerResult = {
  spokenText: string;
  displayText: string;
  /** Speak right away vs. show/queue only; the client policy may downgrade. */
  notify: "speak" | "show";
  /** True when the controller wants explicit confirmation before acting. */
  needsConfirmation: boolean;
  actions: Array<{
    tool: string;
    ok: boolean;
    summary: string;
    conversationId?: string;
  }>;
  model: string;
  toolRounds: number;
  llmMs: number;
  toolMs: number;
  totalMs: number;
};

const MAX_TOOL_ROUNDS = 4;
const MAX_HISTORY_ENTRIES = 16;
const MAX_UTTERANCE_CHARS = 4000;

const SYSTEM_PROMPT = `You are the live voice controller for Cesium, a local-first AI engineering workbench. The user is SPEAKING to you and hears your reply through text-to-speech.

You must return your final answer as a single JSON object, no markdown fences, with exactly these keys:
{"spoken": string, "display": string, "notify": "speak"|"show", "confirm": boolean}

- "spoken": what gets read aloud. Conversational, concise (1-3 short sentences), no markdown, no code, no URLs, no bullet lists. Expand things that read badly aloud.
- "display": what gets shown in the voice panel. May use markdown, may include ids/paths/details. Often slightly fuller than "spoken".
- "notify": "speak" normally; "show" when the content is routine/verbose and interrupting the user aloud is not warranted.
- "confirm": true only when you decided NOT to act yet because the request is destructive or ambiguous and you are asking the user to confirm.

Tool policy:
- Handle DIRECTLY (no tools, or 1-2 quick tool calls): greetings, quick questions, listing sessions, checking one session's status.
- DELEGATE via session_start (new task) or session_message (existing session): code edits, multi-file analysis, builds/tests, package installs, research, long terminal work, anything destructive, anything needing persistent context. Delegation returns immediately; the agent keeps working in the background.
- When you delegate, ACKNOWLEDGE EARLY: say what you actually started, e.g. "I started an agent tracing the login bug." Do not promise results or wait for them.
- Never call a tool merely to interpret playback commands like "stop talking" — the client handles those locally.
- If several separable tasks are requested, you may start several sessions.

Speech style: natural, direct, no filler. Refer to sessions by their title, not their id, when speaking.`;

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string;
  }>;
  error?: { message?: string } | string;
};

/**
 * Extracts the first JSON object from model output, tolerating code fences
 * and stray prose. Falls back to treating the whole text as spoken content.
 */
export function parseControllerPayload(raw: string): {
  spoken: string;
  display: string;
  notify: "speak" | "show";
  confirm: boolean;
} {
  const fallback = (text: string) => ({
    spoken: text.trim(),
    display: text.trim(),
    notify: "speak" as const,
    confirm: false,
  });
  const text = raw.trim();
  if (!text) return fallback("Done.");
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = unfenced.indexOf("{");
  if (start === -1) return fallback(text);
  // Walk balanced braces so trailing prose after the JSON doesn't break parsing.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < unfenced.length; i++) {
    const ch = unfenced[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(unfenced.slice(start, i + 1)) as Record<
            string,
            unknown
          >;
          const spoken =
            typeof parsed.spoken === "string" && parsed.spoken.trim()
              ? parsed.spoken.trim()
              : typeof parsed.display === "string"
                ? parsed.display.trim()
                : "";
          const display =
            typeof parsed.display === "string" && parsed.display.trim()
              ? parsed.display.trim()
              : spoken;
          if (!spoken && !display) return fallback(text);
          return {
            spoken: spoken || display,
            display,
            notify: parsed.notify === "show" ? "show" : "speak",
            confirm: parsed.confirm === true,
          };
        } catch {
          return fallback(text);
        }
      }
    }
  }
  return fallback(text);
}

export async function runVoiceController(
  workspace: WorkspaceRecord,
  request: VoiceControllerRequest
): Promise<VoiceControllerResult> {
  const { baseUrl, apiKey, model } = voiceControllerEnv();
  if (!baseUrl || !apiKey || !model) {
    throw new Error(
      "Voice controller is not configured. Set CESIUM_BASE_URL/OPENAI_BASE_URL, an API key, and optionally OPENCURSOR_VOICE_MODEL."
    );
  }
  const utterance = request.utterance.trim().slice(0, MAX_UTTERANCE_CHARS);
  if (!utterance) {
    throw new Error("Expected a non-empty utterance.");
  }

  const startedAt = Date.now();
  let llmMs = 0;
  let toolMs = 0;
  const executions: VoiceToolExecution[] = [];

  const history = (request.history ?? [])
    .slice(-MAX_HISTORY_ENTRIES)
    .filter((entry) => entry.content.trim().length > 0)
    .map((entry) => ({
      role: entry.role,
      content: entry.content.slice(0, 2000),
    }));

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map(
      (entry): ChatMessage => ({ role: entry.role, content: entry.content })
    ),
    { role: "user", content: utterance },
  ];

  let finalText = "";
  let toolRounds = 0;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const llmStart = Date.now();
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        tools: VOICE_TOOL_SCHEMAS,
        tool_choice: round === MAX_TOOL_ROUNDS ? "none" : "auto",
        temperature: 0.3,
        ...voiceControllerExtraBody(),
      }),
    });
    llmMs += Date.now() - llmStart;
    const payload = (await response.json().catch(() => null)) as
      | ChatCompletionResponse
      | null;
    if (!response.ok || !payload) {
      const detail =
        typeof payload?.error === "string"
          ? payload.error
          : payload?.error?.message ?? `HTTP ${response.status}`;
      throw new Error(`Voice controller model request failed: ${detail}`);
    }
    const message = payload.choices?.[0]?.message;
    const toolCalls = (message?.tool_calls ?? []).filter(
      (call) => call.function?.name
    );

    if (toolCalls.length === 0) {
      finalText = message?.content ?? "";
      break;
    }

    toolRounds++;
    messages.push({
      role: "assistant",
      content: message?.content ?? null,
      tool_calls: toolCalls.map((call, index) => ({
        id: call.id ?? `call_${round}_${index}`,
        type: "function" as const,
        function: {
          name: call.function!.name!,
          arguments: call.function!.arguments ?? "{}",
        },
      })),
    });

    for (const [index, call] of toolCalls.entries()) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function?.arguments || "{}") as Record<
          string,
          unknown
        >;
      } catch {
        args = {};
      }
      const toolStart = Date.now();
      let execution: VoiceToolExecution;
      try {
        execution = await executeVoiceTool(
          workspace,
          call.function!.name!,
          args
        );
      } catch (error) {
        execution = {
          tool: call.function!.name!,
          ok: false,
          summary:
            error instanceof Error ? error.message : "tool execution failed",
          result: {
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
      toolMs += Date.now() - toolStart;
      executions.push(execution);
      messages.push({
        role: "tool",
        tool_call_id: call.id ?? `call_${round}_${index}`,
        content: JSON.stringify(execution.result),
      });
    }
  }

  const parsed = parseControllerPayload(finalText);
  return {
    spokenText: parsed.spoken,
    displayText: parsed.display,
    notify: parsed.notify,
    needsConfirmation: parsed.confirm,
    actions: executions.map((execution) => ({
      tool: execution.tool,
      ok: execution.ok,
      summary: execution.summary,
      ...(execution.conversationId
        ? { conversationId: execution.conversationId }
        : {}),
    })),
    model,
    toolRounds,
    llmMs,
    toolMs,
    totalMs: Date.now() - startedAt,
  };
}

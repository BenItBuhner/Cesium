import { randomUUID } from "node:crypto";
import type {
  ExtensionUIContext,
  ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentConversationRecord,
  AgentEventInput,
  AgentPermissionCategory,
  AgentPermissionOption,
} from "./types.js";

export function isAllowOptionId(optionId: string | undefined): boolean {
  return optionId === "allow_once" || optionId === "allow_always";
}

/**
 * Minimal slice of the runtime callbacks the UI bridge needs. Kept narrow so
 * the bridge can be unit-tested with an in-memory host.
 */
export type PiAgentUiHost = {
  conversationId: string;
  appendEvents: (events: AgentEventInput[]) => Promise<unknown>;
  updateConversation: (
    patch: (current: AgentConversationRecord) => AgentConversationRecord
  ) => Promise<unknown>;
};

export type PiAgentPermissionResolution = {
  optionId?: string;
  cancelled: boolean;
};

type PendingConfirm = {
  kind: "confirm";
  resolve: (value: PiAgentPermissionResolution) => void;
  cleanup: () => void;
  title: string;
};

type PendingQuestion = {
  kind: "select" | "input" | "editor";
  resolve: (value: string | undefined) => void;
  cleanup: () => void;
  prompt: string;
  options: Array<{ id: string; label: string }>;
};

type PendingDialog = PendingConfirm | PendingQuestion;

export const PI_AGENT_CONFIRM_OPTIONS: AgentPermissionOption[] = [
  { optionId: "allow_once", name: "Allow", kind: "allow_once" },
  { optionId: "reject_once", name: "Reject", kind: "reject_once" },
];

/**
 * Cesium's ask-question card formats a submission as `"<title>: <answer>"`
 * (see `formatAskQuestionSubmission`). Peel that prefix and, for selectors,
 * map the text back onto one of the offered options.
 */
export function parsePiAgentQuestionAnswer(input: {
  answer: string;
  prompt: string;
  options: Array<{ id: string; label: string }>;
}): { text: string; option?: { id: string; label: string } } {
  let text = input.answer.trim();
  const prefix = `${input.prompt.trim()}:`;
  if (prefix.length > 1 && text.toLowerCase().startsWith(prefix.toLowerCase())) {
    text = text.slice(prefix.length).trim();
  } else {
    const generic = /^question\s+\d+:\s*/i.exec(text);
    if (generic) {
      text = text.slice(generic[0].length).trim();
    }
  }
  const lowered = text.toLowerCase();
  const option =
    input.options.find((entry) => entry.label.trim().toLowerCase() === lowered) ??
    input.options.find((entry) => entry.id.toLowerCase() === lowered) ??
    // "A" / "B" letters from the card badge.
    (lowered.length === 1 && /[a-z]/.test(lowered)
      ? input.options[lowered.charCodeAt(0) - 97]
      : undefined);
  return option ? { text: option.label, option } : { text };
}

/**
 * Bridges Pi's `ExtensionUIContext` onto Cesium's conversation primitives:
 * `confirm` becomes a permission card, `select`/`input`/`editor` become
 * ask-question cards, `notify` becomes a system row. Everything terminal-only
 * (widgets, footers, editors, themes) delegates to Pi's no-op context so
 * extensions keep working without special-casing Cesium.
 */
export class PiAgentUiBridge {
  private readonly pending = new Map<string, PendingDialog>();
  private readonly nextId: () => string;

  constructor(
    private readonly host: PiAgentUiHost,
    options?: { eventId?: () => string }
  ) {
    this.nextId = options?.eventId ?? (() => randomUUID());
  }

  get hasPendingDialog(): boolean {
    return this.pending.size > 0;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  createUiContext(fallback: ExtensionUIContext): ExtensionUIContext {
    return {
      select: (title, options, opts) => this.select(title, options, opts),
      confirm: (title, message, opts) => this.confirm(title, message, opts),
      input: (title, placeholder, opts) => this.input(title, placeholder, opts),
      notify: (message, type) => {
        void this.notify(message, type);
      },
      editor: (title, prefill) => this.editor(title, prefill),
      onTerminalInput: () => () => undefined,
      setStatus: () => undefined,
      setWorkingMessage: () => undefined,
      setWorkingVisible: () => undefined,
      setWorkingIndicator: () => undefined,
      setHiddenThinkingLabel: () => undefined,
      setWidget: () => undefined,
      setFooter: () => undefined,
      setHeader: () => undefined,
      setTitle: () => undefined,
      custom: async () => undefined as never,
      pasteToEditor: () => undefined,
      setEditorText: () => undefined,
      getEditorText: () => "",
      addAutocompleteProvider: () => undefined,
      setEditorComponent: () => undefined,
      getEditorComponent: () => undefined,
      get theme() {
        return fallback.theme;
      },
      getAllThemes: () => fallback.getAllThemes(),
      getTheme: (name) => fallback.getTheme(name),
      setTheme: () => ({ success: false, error: "Theme switching is not available in Cesium." }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => undefined,
    };
  }

  async notify(message: string, type?: "info" | "warning" | "error"): Promise<void> {
    const text = message.trim();
    if (!text) {
      return;
    }
    await this.host.appendEvents([
      {
        eventId: this.nextId(),
        conversationId: this.host.conversationId,
        kind: "system",
        level: type === "error" ? "error" : type === "warning" ? "warning" : "info",
        text,
        raw: { source: "pi-agent-extension-notify" },
      },
    ]);
  }

  private armDialogGuards(
    id: string,
    opts: ExtensionUIDialogOptions | undefined,
    onExpire: () => void
  ): () => void {
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => onExpire();
    if (opts?.signal) {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    if (opts?.timeout && opts.timeout > 0) {
      timer = setTimeout(onExpire, opts.timeout);
    }
    return () => {
      if (timer) {
        clearTimeout(timer);
      }
      opts?.signal?.removeEventListener("abort", onAbort);
      this.pending.delete(id);
    };
  }

  /**
   * Surface a Cesium permission card and wait for the user's pick. Used by the
   * extension `confirm()` dialog (Allow/Reject) and by the harness approval
   * gate (full allow/reject once/always option set).
   */
  async requestPermission(input: {
    title: string;
    detail?: string;
    options: AgentPermissionOption[];
    permission?: AgentPermissionCategory;
    toolCallId?: string;
    source: string;
    opts?: ExtensionUIDialogOptions;
  }): Promise<PiAgentPermissionResolution> {
    if (input.opts?.signal?.aborted) {
      return { cancelled: true };
    }
    const requestId = `pi-agent-permission-${this.nextId()}`;
    const detail = input.detail?.trim() || undefined;
    await this.host.appendEvents([
      {
        eventId: this.nextId(),
        conversationId: this.host.conversationId,
        kind: "permission_request",
        requestId,
        title: input.title,
        ...(detail ? { detail } : {}),
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        options: input.options,
        raw: { source: input.source },
      },
      {
        eventId: this.nextId(),
        conversationId: this.host.conversationId,
        kind: "status",
        status: "awaiting_permission",
        detail: input.title,
      },
    ]);
    await this.host.updateConversation((current) => ({
      ...current,
      status: "awaiting_permission",
      pendingPermission: {
        requestId,
        requestedAt: Date.now(),
        title: input.title,
        ...(detail ? { detail } : {}),
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        ...(input.permission ? { permission: input.permission } : {}),
        options: input.options,
      },
    }));
    return new Promise<PiAgentPermissionResolution>((resolve) => {
      const cleanup = this.armDialogGuards(requestId, input.opts, () => {
        void this.settleConfirm(requestId, { cancelled: true }, "cancelled");
      });
      this.pending.set(requestId, { kind: "confirm", resolve, cleanup, title: input.title });
    });
  }

  async confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> {
    const resolution = await this.requestPermission({
      title,
      detail: message,
      options: PI_AGENT_CONFIRM_OPTIONS,
      source: "pi-agent-extension-confirm",
      opts,
    });
    return !resolution.cancelled && isAllowOptionId(resolution.optionId);
  }

  private async settleConfirm(
    requestId: string,
    resolution: PiAgentPermissionResolution,
    outcome: "selected" | "cancelled",
    optionId?: string,
    resumeRunning = true
  ): Promise<boolean> {
    const pending = this.pending.get(requestId);
    if (!pending || pending.kind !== "confirm") {
      return false;
    }
    pending.cleanup();
    pending.resolve(resolution);
    await this.host.appendEvents([
      {
        eventId: this.nextId(),
        conversationId: this.host.conversationId,
        kind: "permission_resolved",
        requestId,
        outcome,
        ...(optionId ? { optionId } : {}),
      },
      ...(resumeRunning
        ? [
            {
              eventId: this.nextId(),
              conversationId: this.host.conversationId,
              kind: "status" as const,
              status: "running" as const,
            },
          ]
        : []),
    ]);
    await this.host.updateConversation((current) => ({
      ...current,
      pendingPermission:
        current.pendingPermission?.requestId === requestId ? null : current.pendingPermission,
      status: current.status === "awaiting_permission" ? "running" : current.status,
    }));
    return true;
  }

  private async askQuestion(
    kind: PendingQuestion["kind"],
    prompt: string,
    options: Array<{ id: string; label: string }>,
    opts?: ExtensionUIDialogOptions
  ): Promise<string | undefined> {
    if (opts?.signal?.aborted) {
      return undefined;
    }
    const questionId = `pi-agent-question-${this.nextId()}`;
    await this.host.appendEvents([
      {
        eventId: this.nextId(),
        conversationId: this.host.conversationId,
        kind: "question",
        questionId,
        prompt,
        options,
        allowMultiple: false,
        status: "pending",
        raw: { source: `pi-agent-extension-${kind}` },
      },
      {
        eventId: this.nextId(),
        conversationId: this.host.conversationId,
        kind: "status",
        status: "awaiting_question",
        detail: prompt,
      },
    ]);
    await this.host.updateConversation((current) => ({
      ...current,
      status: "awaiting_question",
      pendingQuestion: { questionId, requestedAt: Date.now() },
    }));
    return new Promise<string | undefined>((resolve) => {
      const cleanup = this.armDialogGuards(questionId, opts, () => {
        void this.settleQuestion(questionId, undefined, "cancelled");
      });
      this.pending.set(questionId, { kind, resolve, cleanup, prompt, options });
    });
  }

  async select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
    return this.askQuestion(
      "select",
      title,
      options.map((label, index) => ({ id: `option-${index + 1}`, label })),
      opts
    );
  }

  async input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
    const hint = placeholder?.trim();
    return this.askQuestion("input", hint ? `${title} (${hint})` : title, [], opts);
  }

  async editor(title: string, prefill?: string): Promise<string | undefined> {
    const current = prefill?.trim();
    return this.askQuestion(
      "editor",
      current ? `${title}\n\nCurrent text:\n${current}` : title,
      []
    );
  }

  private async settleQuestion(
    questionId: string,
    answer: string | undefined,
    status: "answered" | "cancelled",
    resumeRunning = true
  ): Promise<boolean> {
    const pending = this.pending.get(questionId);
    if (!pending || pending.kind === "confirm") {
      return false;
    }
    pending.cleanup();
    pending.resolve(answer);
    await this.host.appendEvents([
      {
        eventId: this.nextId(),
        conversationId: this.host.conversationId,
        kind: "question",
        questionId,
        prompt: pending.prompt,
        options: pending.options,
        allowMultiple: false,
        status,
        ...(answer !== undefined ? { answer } : {}),
      },
      ...(resumeRunning
        ? [
            {
              eventId: this.nextId(),
              conversationId: this.host.conversationId,
              kind: "status" as const,
              status: "running" as const,
            },
          ]
        : []),
    ]);
    await this.host.updateConversation((current) => ({
      ...current,
      pendingQuestion:
        current.pendingQuestion?.questionId === questionId ? null : current.pendingQuestion,
      status: current.status === "awaiting_question" ? "running" : current.status,
    }));
    return true;
  }

  /** Resolve a permission card answer. Returns false when the id is unknown. */
  async answerPermission(input: {
    requestId: string;
    optionId?: string;
    cancelled?: boolean;
  }): Promise<boolean> {
    const pending = this.pending.get(input.requestId);
    if (!pending || pending.kind !== "confirm") {
      return false;
    }
    if (input.cancelled) {
      return this.settleConfirm(input.requestId, { cancelled: true }, "cancelled");
    }
    return this.settleConfirm(
      input.requestId,
      { optionId: input.optionId, cancelled: false },
      "selected",
      input.optionId
    );
  }

  /** Resolve an ask-question card answer. Returns false when the id is unknown. */
  async answerQuestion(input: { questionId: string; answer: string }): Promise<boolean> {
    const pending = this.pending.get(input.questionId);
    if (!pending || pending.kind === "confirm") {
      return false;
    }
    const parsed = parsePiAgentQuestionAnswer({
      answer: input.answer,
      prompt: pending.prompt,
      options: pending.options,
    });
    const value = pending.kind === "select" ? parsed.option?.label ?? parsed.text : parsed.text;
    return this.settleQuestion(input.questionId, value || undefined, "answered");
  }

  /**
   * Resolve every open dialog with its cancel value (turn cancelled or session
   * disposed). The caller owns the terminal status, so no `running` status is
   * emitted here.
   */
  async cancelAll(): Promise<void> {
    const ids = [...this.pending.keys()];
    for (const id of ids) {
      const pending = this.pending.get(id);
      if (!pending) {
        continue;
      }
      if (pending.kind === "confirm") {
        await this.settleConfirm(id, { cancelled: true }, "cancelled", undefined, false);
      } else {
        await this.settleQuestion(id, undefined, "cancelled", false);
      }
    }
  }
}

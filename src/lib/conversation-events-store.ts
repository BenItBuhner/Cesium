import type { AgentStoredEvent } from "@/lib/agent-types";

export type ConversationEventsListener = () => void;

export const EMPTY_CONVERSATION_EVENTS: AgentStoredEvent[] = [];

/**
 * External (non-React-state) store for per-conversation event arrays.
 *
 * The event log is by far the hottest data in the app: every streaming flush
 * for any conversation rewrites its array. Holding all logs in one React
 * context value meant one token from one agent re-rendered every consumer of
 * that context — rail, composers, tab strips, editor panels — which collapses
 * once more than a handful of agents run in parallel. This store instead
 * notifies only subscribers of the conversation that actually changed;
 * components read a single conversation through `useSyncExternalStore` and
 * stay inert while other agents stream.
 */
export class ConversationEventsStore {
  private eventsById = new Map<string, AgentStoredEvent[]>();
  private keyListeners = new Map<string, Set<ConversationEventsListener>>();
  private anyListeners = new Set<ConversationEventsListener>();
  /** Bumped only when the *set of known conversations* changes (snapshot load, delete, reset). */
  private keysVersion = 0;
  private keysListeners = new Set<ConversationEventsListener>();

  get(conversationId: string): AgentStoredEvent[] {
    return this.eventsById.get(conversationId) ?? EMPTY_CONVERSATION_EVENTS;
  }

  /** Whether a snapshot/event log has been loaded for the conversation (even if empty). */
  has(conversationId: string): boolean {
    return this.eventsById.has(conversationId);
  }

  getKeysVersion(): number {
    return this.keysVersion;
  }

  set(conversationId: string, events: AgentStoredEvent[]): void {
    const existing = this.eventsById.get(conversationId);
    if (existing === events) {
      return;
    }
    const isNewKey = existing === undefined;
    this.eventsById.set(conversationId, events);
    if (isNewKey) {
      this.bumpKeys();
    }
    this.notifyKey(conversationId);
  }

  /** `updater` returning the existing array (identity) skips notification. */
  update(
    conversationId: string,
    updater: (existing: AgentStoredEvent[]) => AgentStoredEvent[]
  ): void {
    this.set(conversationId, updater(this.get(conversationId)));
  }

  delete(conversationId: string): void {
    if (!this.eventsById.delete(conversationId)) {
      return;
    }
    this.bumpKeys();
    this.notifyKey(conversationId);
  }

  clear(): void {
    if (this.eventsById.size === 0) {
      return;
    }
    const keys = [...this.eventsById.keys()];
    this.eventsById.clear();
    this.bumpKeys();
    for (const key of keys) {
      this.notifyKey(key, /* skipAny */ true);
    }
    this.notifyAny();
  }

  /** Ids with a loaded event log. */
  keys(): string[] {
    return [...this.eventsById.keys()];
  }

  subscribe(conversationId: string, listener: ConversationEventsListener): () => void {
    let set = this.keyListeners.get(conversationId);
    if (!set) {
      set = new Set();
      this.keyListeners.set(conversationId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) {
        this.keyListeners.delete(conversationId);
      }
    };
  }

  /** Fires on any conversation's change. Use sparingly (bridges, aggregations). */
  subscribeAny(listener: ConversationEventsListener): () => void {
    this.anyListeners.add(listener);
    return () => {
      this.anyListeners.delete(listener);
    };
  }

  /** Fires when the set of loaded conversations changes (rarely). */
  subscribeKeys(listener: ConversationEventsListener): () => void {
    this.keysListeners.add(listener);
    return () => {
      this.keysListeners.delete(listener);
    };
  }

  private bumpKeys(): void {
    this.keysVersion += 1;
    for (const listener of [...this.keysListeners]) {
      listener();
    }
  }

  private notifyKey(conversationId: string, skipAny = false): void {
    const listeners = this.keyListeners.get(conversationId);
    if (listeners) {
      for (const listener of [...listeners]) {
        listener();
      }
    }
    if (!skipAny) {
      this.notifyAny();
    }
  }

  private notifyAny(): void {
    for (const listener of [...this.anyListeners]) {
      listener();
    }
  }
}

import { subscribeAgentStoreEvents } from "../session-store.js";
import type { AgentStoredEvent } from "../types.js";

/**
 * Live tail of a parent conversation for one side-chat turn.
 *
 * Attached before the turn reads its idle delta and detached when the turn
 * ends, it buffers every parent event published on the store bus so the
 * running side chat can inject fresh primary-chat context between tool
 * iterations. Buffering is seq-ordered and deduplicated; `discardThrough`
 * drops anything the idle delta already covered so a parent event is never
 * delivered twice.
 */
export class SideChatTail {
  private readonly buffered = new Map<number, AgentStoredEvent>();
  private unsubscribe: (() => void) | null = null;
  private deliveredThroughSeq: number;
  private parentDeletedFlag = false;

  constructor(
    private readonly options: {
      workspaceId: string;
      parentConversationId: string;
      /** Highest parent seq already delivered; only newer events are buffered. */
      sinceSeq: number;
    }
  ) {
    this.deliveredThroughSeq = options.sinceSeq;
  }

  attach(): void {
    if (this.unsubscribe) {
      return;
    }
    this.unsubscribe = subscribeAgentStoreEvents((event) => {
      if (event.type === "event") {
        if (
          event.conversationId !== this.options.parentConversationId ||
          event.workspaceId !== this.options.workspaceId
        ) {
          return;
        }
        if (event.event.seq <= this.deliveredThroughSeq) {
          return;
        }
        this.buffered.set(event.event.seq, event.event);
        return;
      }
      if (
        event.type === "conversation_deleted" &&
        event.conversationId === this.options.parentConversationId
      ) {
        this.parentDeletedFlag = true;
      }
    });
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.buffered.clear();
  }

  get attached(): boolean {
    return this.unsubscribe !== null;
  }

  get parentDeleted(): boolean {
    return this.parentDeletedFlag;
  }

  /** Highest parent seq handed out (or covered) so far. */
  get throughSeq(): number {
    return this.deliveredThroughSeq;
  }

  hasPending(): boolean {
    return this.buffered.size > 0;
  }

  /** Forget events at or below `seq`; used after the idle delta covered them. */
  discardThrough(seq: number): void {
    if (seq <= this.deliveredThroughSeq) {
      return;
    }
    this.deliveredThroughSeq = seq;
    for (const key of [...this.buffered.keys()]) {
      if (key <= seq) {
        this.buffered.delete(key);
      }
    }
  }

  /**
   * Take everything buffered so far, seq-ascending. The caller formats it and,
   * if the block persists, the cursor advances through the last event; if the
   * slice was pure noise, `discardThrough` is still applied so noise is not
   * re-read next iteration.
   */
  drain(): AgentStoredEvent[] {
    if (this.buffered.size === 0) {
      return [];
    }
    const events = [...this.buffered.values()].sort((a, b) => a.seq - b.seq);
    this.buffered.clear();
    const last = events[events.length - 1];
    if (last) {
      this.deliveredThroughSeq = Math.max(this.deliveredThroughSeq, last.seq);
    }
    return events;
  }
}

import type { WorkspaceRecord } from "../../../workspace-registry.js";
import type {
  AgentConversationRecord,
  AgentConversationSnapshot,
  AgentEventInput,
  AgentRuntimeCallbacks,
  AgentStoredEvent,
} from "../../types.js";

/** What a tool module may use of the session running it. */
export type CesiumToolContext = {
  workspace: WorkspaceRecord;
  conversationId: string;
  /** The conversation record as of this tool call. */
  conversation: AgentConversationRecord;
  updateConversation: AgentRuntimeCallbacks["updateConversation"];
  appendEvents(events: AgentEventInput[]): Promise<unknown>;
  readSnapshot(): Promise<AgentConversationSnapshot | null>;
  /** Every stored event of the conversation (the snapshot is a bounded head). */
  readEvents(): Promise<AgentStoredEvent[]>;
  /** Roots outside the workspace that absolute paths may also point into (read and write). */
  extraRoots: string[];
  /** A root `read_file` may read but no tool may write: this conversation's spilled tool outputs. */
  readOnlyRoot: string;
  /** Whether the current model accepts image attachments. */
  turnSupportsImages: boolean;
  /** Attaches an image the tool produced to the model's next request. */
  attachImage(image: { mimeType: string; data: string; source: string }): void;
  /** Replaces the title the tool call's completion event will carry. */
  refineTitle(toolCallId: string, title: string): void;
};

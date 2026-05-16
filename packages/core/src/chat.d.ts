import type { AgentStoredEvent } from "./protocol";
export type ChatMessageKind = "user" | "assistant" | "reasoning" | "tool" | "status";
export type ProjectedChatMessage = {
    id: string;
    kind: ChatMessageKind;
    text?: string;
    status?: string;
    toolCallId?: string;
    title?: string;
    createdAt: number;
};
export declare function projectAgentEventToMessage(event: AgentStoredEvent): ProjectedChatMessage | null;
//# sourceMappingURL=chat.d.ts.map
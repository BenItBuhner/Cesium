import { ChatMarkdown } from "./ChatMarkdown";
import { MessageTextSelectionCite } from "./MessageTextSelectionCite";

interface AssistantMessageProps {
  content: string;
  composerDraftId?: string | null;
}

export function AssistantMessage({ content, composerDraftId }: AssistantMessageProps) {
  return (
    <MessageTextSelectionCite composerDraftId={composerDraftId} className="min-w-0 select-text">
      <ChatMarkdown source={content} />
    </MessageTextSelectionCite>
  );
}

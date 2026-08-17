import { memo } from "react";
import { ChatMarkdown } from "./ChatMarkdown";
import { MessageTextSelectionCite } from "./MessageTextSelectionCite";

interface AssistantMessageProps {
  content: string;
  composerDraftId?: string | null;
}

/**
 * Memoized: streaming flushes re-render the whole thread host, but settled
 * assistant messages keep object identity (projection reconciliation), so
 * they skip re-parsing and re-rendering their markdown entirely.
 */
export const AssistantMessage = memo(function AssistantMessage({
  content,
  composerDraftId,
}: AssistantMessageProps) {
  return (
    <MessageTextSelectionCite composerDraftId={composerDraftId} className="min-w-0 select-text">
      <ChatMarkdown source={content} />
    </MessageTextSelectionCite>
  );
});

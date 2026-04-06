import { ChatMarkdown } from "./ChatMarkdown";

interface AssistantMessageProps {
  content: string;
}

export function AssistantMessage({ content }: AssistantMessageProps) {
  return <ChatMarkdown source={content} />;
}

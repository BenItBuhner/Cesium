"use client";

import { useMemo } from "react";
import type { ChatMessage } from "@/lib/types";
import { SubagentCard } from "./SubagentCard";

function firstNonEmptyLine(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function inferRecentActivity(messages: ChatMessage[], fallback: string | undefined): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === "worked-session") {
      const tool = message.workedEntries?.find((entry) => entry.kind === "tool");
      if (tool && tool.kind === "tool") {
        return tool.title;
      }
    }
    if (message?.type === "assistant") {
      const line = firstNonEmptyLine(message.content);
      if (line) {
        return line;
      }
    }
  }
  return firstNonEmptyLine(fallback);
}

export function LiveSubagentCard({
  title,
  meta,
  recentActivity,
  complete,
  transcript,
  sessionId,
  onOpenTranscript,
}: {
  title: string;
  meta?: string;
  recentActivity?: string;
  complete?: boolean;
  transcript?: ChatMessage[];
  sessionId?: string;
  onOpenTranscript?: (payload: { transcript: ChatMessage[]; sessionId?: string }) => void;
}) {
  const renderedTranscript = transcript ?? [];
  const renderedRecentActivity = useMemo(
    () => inferRecentActivity(renderedTranscript, recentActivity),
    [renderedTranscript, recentActivity]
  );

  return (
    <SubagentCard
      title={title}
      meta={meta}
      recentActivity={renderedRecentActivity}
      complete={Boolean(complete)}
      interactive={Boolean(onOpenTranscript)}
      onOpen={
        onOpenTranscript
          ? () => onOpenTranscript({ transcript: renderedTranscript, sessionId })
          : undefined
      }
    />
  );
}

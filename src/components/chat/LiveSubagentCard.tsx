"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchOpenCodeSubagentSession } from "@/lib/server-api";
import { projectOpenCodeExportToChatMessages } from "@/lib/opencode-export-transcript";
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
  const [liveTranscript, setLiveTranscript] = useState<ChatMessage[] | null>(null);
  const [liveComplete, setLiveComplete] = useState(Boolean(complete));

  useEffect(() => {
    setLiveTranscript(null);
    setLiveComplete(Boolean(complete));
  }, [complete, sessionId, transcript]);

  useEffect(() => {
    if (!sessionId?.startsWith("ses_") || complete) {
      return;
    }
    let cancelled = false;
    let timer: number | null = null;

    const tick = async () => {
      try {
        const result = await fetchOpenCodeSubagentSession(sessionId);
        if (cancelled) {
          return;
        }
        const projected = projectOpenCodeExportToChatMessages(result.session);
        setLiveTranscript((current) => {
          const next = projected.messages;
          return JSON.stringify(current) === JSON.stringify(next) ? current : next;
        });
        setLiveComplete(projected.complete);
        if (!projected.complete) {
          timer = window.setTimeout(tick, 2000);
        }
      } catch {
        timer = window.setTimeout(tick, 4000);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer != null) {
        window.clearTimeout(timer);
      }
    };
  }, [complete, sessionId]);

  const renderedTranscript = useMemo(
    () => (liveTranscript && liveTranscript.length > 0 ? liveTranscript : transcript ?? []),
    [liveTranscript, transcript]
  );
  const renderedRecentActivity = useMemo(
    () => inferRecentActivity(renderedTranscript, recentActivity),
    [renderedTranscript, recentActivity]
  );
  const finalComplete = complete ? true : liveComplete;

  return (
    <SubagentCard
      title={title}
      meta={meta}
      recentActivity={renderedRecentActivity}
      complete={finalComplete}
      interactive={Boolean(onOpenTranscript)}
      onOpen={
        onOpenTranscript
          ? () => onOpenTranscript({ transcript: renderedTranscript, sessionId })
          : undefined
      }
    />
  );
}

import { asNumber } from "../../json-coerce.js";
import { asString, safeJson } from "../cesium-coerce.js";
import { applyConversationTitleAction, listConversationsForAgent, parseConversationTitleToolArgs, readConversationTranscriptForAgent, searchConversationsForAgent } from "../cesium-conversation-tools.js";
import type { CesiumToolContext } from "./types.js";

export async function searchHistoryTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>): Promise<string> {
  const query = asString(args.query);
  if (!query) throw new Error("search_history.query is required.");
  const maxResults = Math.max(1, Math.min(50, Math.floor(asNumber(args.maxResults) ?? 10)));
  const snapshot = await ctx.readSnapshot();
  const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const matches = (snapshot?.events ?? [])
    .filter((event) => regex.test(safeJson(event)))
    .slice(-maxResults);
  return matches.length ? matches.map((event) => `seq ${event.seq} ${event.kind}: ${safeJson(event)}`).join("\n\n") : "No history matches.";
}

export async function readHistoryPageTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>): Promise<string> {
  const beforeSeq = Math.floor(asNumber(args.beforeSeq) ?? Number.MAX_SAFE_INTEGER);
  const limitTurns = Math.max(1, Math.min(250, Math.floor(asNumber(args.limitTurns) ?? 25)));
  const snapshot = await ctx.readSnapshot();
  const events = (snapshot?.events ?? []).filter((event) => event.seq < beforeSeq);
  let users = 0;
  let start = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]!.kind === "user_message") {
      users += 1;
      start = index;
      if (users >= limitTurns) break;
    }
  }
  return events.slice(start).map((event) => `seq ${event.seq} ${event.kind}: ${safeJson(event)}`).join("\n");
}

export async function listConversationsTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>): Promise<string> {
  return listConversationsForAgent({
    query: asString(args.query),
    workspaceId: asString(args.workspaceId),
    limit: asNumber(args.limit),
    currentConversationId: ctx.conversationId,
  });
}

export async function readConversationTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>): Promise<string> {
  const conversationId = asString(args.conversationId);
  if (!conversationId) {
    throw new Error("read_conversation.conversationId is required.");
  }
  return readConversationTranscriptForAgent({
    conversationId,
    limitTurns: asNumber(args.limitTurns),
    maxChars: asNumber(args.maxChars),
  });
}

export async function searchConversationsTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>): Promise<string> {
  const query = asString(args.query);
  if (!query) {
    throw new Error("search_conversations.query is required.");
  }
  return searchConversationsForAgent({
    query,
    conversationId: asString(args.conversationId),
    maxResults: asNumber(args.maxResults),
  });
}

/** Read or rename this conversation's display title; optional follow flag. */
export async function conversationTitleTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>): Promise<string> {
  const parsed = parseConversationTitleToolArgs(args);
  const current = ctx.conversation;
  const applied = applyConversationTitleAction({
    currentTitle: current.title,
    currentFollow: Boolean(current.config.titleFollow),
    action: parsed.action,
    title: parsed.title,
    follow: parsed.follow,
  });
  if (applied.changed) {
    await ctx.updateConversation((record) => ({
      ...record,
      title: applied.nextTitle,
      config: {
        ...record.config,
        titleFollow: applied.nextFollow,
      },
    }));
  }
  return applied.result;
}

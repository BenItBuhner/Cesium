import { type CesiumMemoryCategory, type CesiumMemoryScope, forgetCesiumMemoryEntry, formatCesiumMemoryEntry, formatCesiumMemorySaveResult, listCesiumMemoryEntries, saveCesiumMemoryEntry, searchCesiumMemoryEntries } from "../../cesium-memory.js";
import { asNumber } from "../../json-coerce.js";
import { asString } from "../cesium-coerce.js";
import type { CesiumToolContext } from "./types.js";

/** Curated persistent memory: save/search/list/forget over bounded JSON stores. */
export async function memoryTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>): Promise<string> {
  const action = asString(args.action)?.trim().toLowerCase();
  const workspaceId = ctx.workspace.id;
  const rawScope = asString(args.scope)?.trim().toLowerCase();
  const scope: CesiumMemoryScope | undefined =
    rawScope === "user" || rawScope === "workspace" ? rawScope : undefined;
  switch (action) {
    case "save": {
      const content = asString(args.content)?.trim();
      if (!content) {
        throw new Error("memory.content is required for save.");
      }
      const rawCategory = asString(args.category)?.trim().toLowerCase();
      const category: CesiumMemoryCategory =
        rawCategory === "preference" ||
        rawCategory === "constraint" ||
        rawCategory === "decision"
          ? rawCategory
          : "fact";
      const saved = await saveCesiumMemoryEntry({
        workspaceId,
        scope: scope ?? "workspace",
        category,
        content,
        key: asString(args.key),
        sourceConversationId: ctx.conversationId,
        id: asString(args.id)?.trim() || undefined,
      });
      return formatCesiumMemorySaveResult(saved);
    }
    case "search": {
      const query = asString(args.query)?.trim();
      if (!query) {
        throw new Error("memory.query is required for search.");
      }
      const entries = await searchCesiumMemoryEntries({
        workspaceId,
        query,
        scope,
        limit: asNumber(args.limit),
      });
      if (entries.length === 0) {
        return `No memory entries match "${query}".`;
      }
      return [
        `${entries.length} memory entr${entries.length === 1 ? "y" : "ies"} match "${query}":`,
        ...entries.map((entry) => formatCesiumMemoryEntry(entry)),
      ].join("\n");
    }
    case "list": {
      const limit = Math.min(Math.max(asNumber(args.limit) ?? 10, 1), 50);
      const entries = (await listCesiumMemoryEntries({ workspaceId, scope })).slice(0, limit);
      if (entries.length === 0) {
        return scope
          ? `No memory entries saved in the ${scope} scope yet.`
          : "No memory entries saved yet.";
      }
      return [
        `${entries.length} memory entr${entries.length === 1 ? "y" : "ies"} (most recent first):`,
        ...entries.map((entry) => formatCesiumMemoryEntry(entry)),
      ].join("\n");
    }
    case "forget": {
      const id = asString(args.id)?.trim();
      if (!id) {
        throw new Error("memory.id is required for forget.");
      }
      const removed = await forgetCesiumMemoryEntry({ workspaceId, id });
      if (!removed) {
        return `No memory entry with id ${id}. Use memory list to see current entries.`;
      }
      return `Forgot memory entry.\n${formatCesiumMemoryEntry(removed)}`;
    }
    default:
      throw new Error('memory.action must be one of "save", "search", "list", "forget".');
  }
}

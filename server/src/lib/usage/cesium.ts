import { getStorage } from "../../storage/index.js";
import type { AgentConversationRecord } from "../agents/types.js";
import { UsageAggregator, estimateTokensFromText } from "./helpers.js";
import type { ProviderUsageReport } from "./types.js";

/**
 * Cesium Agent (built-in harness) usage: the runtime does not persist
 * provider-reported token counts yet, so we estimate (chars/4, same
 * heuristic as the context-usage ring) from stored conversation events.
 * Only `cesium-agent` conversations are counted - external harnesses write
 * their own native session files which their dedicated collectors read,
 * so counting them here would double-report.
 */

const BASE = { id: "cesium-agent", label: "Cesium Agent", vendor: "Cesium" } as const;

/** Hard cap so a giant archive cannot stall the usage endpoint. */
const MAX_CONVERSATIONS = 300;
const MAX_EVENTS_PER_CONVERSATION = 10_000;

export async function collectCesiumUsage(sinceMs: number): Promise<ProviderUsageReport> {
  const storage = await getStorage();
  const workspaces = await storage.listWorkspaces();

  const candidates: AgentConversationRecord[] = [];
  for (const workspace of workspaces) {
    let cursor: string | null = null;
    do {
      const page = await storage.listAgentConversations({
        workspaceId: workspace.id,
        includeArchived: true,
        limit: 200,
        cursor,
      });
      for (const record of page.records) {
        if (record.config.backendId === "cesium-agent" && record.updatedAt >= sinceMs) {
          candidates.push(record);
        }
      }
      // Listing is updatedAt-desc; once a page dips below the window, stop.
      const oldest = page.records[page.records.length - 1];
      cursor = oldest && oldest.updatedAt >= sinceMs ? page.nextCursor : null;
    } while (cursor);
  }

  candidates.sort((a, b) => b.updatedAt - a.updatedAt);
  const selected = candidates.slice(0, MAX_CONVERSATIONS);

  const aggregator = new UsageAggregator();
  for (const record of selected) {
    const model = record.config.modelName || record.config.modelId || "unknown";
    let counted = false;
    const events = await storage.readAgentEvents({
      conversationId: record.id,
      afterSeq: 0,
      limit: MAX_EVENTS_PER_CONVERSATION,
    });
    for (const event of events) {
      if (event.createdAt < sinceMs) {
        continue;
      }
      if (event.kind === "user_message") {
        const estimate = estimateTokensFromText(event.content);
        if (estimate > 0) {
          aggregator.add(
            event.createdAt,
            model,
            { inputTokens: estimate, totalTokens: estimate },
            { countRequest: false }
          );
          counted = true;
        }
      } else if (event.kind === "assistant_message_chunk") {
        const estimate = estimateTokensFromText(event.text);
        if (estimate > 0) {
          aggregator.add(
            event.createdAt,
            model,
            { outputTokens: estimate, totalTokens: estimate },
            { countRequest: false }
          );
          counted = true;
        }
      } else if (event.kind === "reasoning") {
        const estimate = estimateTokensFromText(event.text);
        if (estimate > 0) {
          aggregator.add(
            event.createdAt,
            model,
            { reasoningTokens: estimate, totalTokens: estimate },
            { countRequest: false }
          );
          counted = true;
        }
      } else if (event.kind === "assistant_message_end") {
        aggregator.add(event.createdAt, model, {}, { countRequest: true });
        counted = true;
      }
    }
    if (counted) {
      aggregator.addSession(record.id);
    }
  }

  const { totals, days, series, models, lastActivityAt } = aggregator.finish();
  return {
    ...BASE,
    available: true,
    reason: null,
    storageRoot: null,
    plan: null,
    limitWindows: [],
    limitSnapshots: [],
    totals,
    days,
    series,
    models,
    estimated: true,
    lastActivityAt,
  };
}

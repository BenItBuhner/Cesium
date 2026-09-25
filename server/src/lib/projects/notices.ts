import {
  PROJECT_AGENT_UPDATES_TAG,
  formatProjectNoticeDisplay,
} from "@cesium/core/projects";

export type ProjectNoticeEvent = "finished" | "failed" | "stopped" | "needs_attention";

export type ProjectNoticeUpdate = {
  name: string;
  event: ProjectNoticeEvent;
  status: string;
  detail: string | null;
};

const INTRO =
  "Automatic update from your Project agents. Previews are truncated; use project_read_transcript for the full picture.";

const BLOCK_PATTERN = /<agent name="([^"]+)" event="([^"]+)" status="([^"]*)">\n?([\s\S]*?)\n?<\/agent>/g;

/** Child text must not open or close notice markup, or merging would mis-split blocks. */
function sanitizeDetail(detail: string): string {
  return detail
    .replace(/<(\/?)agent\b/gi, "< $1agent")
    .replace(new RegExp(`</?${PROJECT_AGENT_UPDATES_TAG}>`, "gi"), "");
}

function renderBlock(update: ProjectNoticeUpdate): string {
  const body = update.detail?.trim() ? sanitizeDetail(update.detail.trim()) : "(no reply text)";
  return `<agent name="${update.name}" event="${update.event}" status="${update.status}">\n${body}\n</agent>`;
}

/** Agent blocks already present in a queued notice, in order. */
export function parseProjectNoticeBlocks(text: string): ProjectNoticeUpdate[] {
  const blocks: ProjectNoticeUpdate[] = [];
  for (const match of text.matchAll(BLOCK_PATTERN)) {
    blocks.push({
      name: match[1]!,
      event: match[2] as ProjectNoticeEvent,
      status: match[3] ?? "",
      detail: match[4] ?? null,
    });
  }
  return blocks;
}

/**
 * Builds (or folds into) the orchestrator turn that carries child reports.
 * A newer update for the same agent replaces its older block, so a queued
 * notice always holds each agent's latest state once.
 */
export function composeProjectNotice(
  existingText: string | null,
  updates: readonly ProjectNoticeUpdate[]
): { text: string; displayContent: string } {
  const merged = existingText ? parseProjectNoticeBlocks(existingText) : [];
  for (const update of updates) {
    const index = merged.findIndex((block) => block.name === update.name);
    if (index >= 0) {
      merged.splice(index, 1);
    }
    merged.push(update);
  }
  const text = [
    `<${PROJECT_AGENT_UPDATES_TAG}>`,
    INTRO,
    ...merged.map(renderBlock),
    `</${PROJECT_AGENT_UPDATES_TAG}>`,
  ].join("\n");
  return { text, displayContent: formatProjectNoticeDisplay(merged.map((block) => block.name)) };
}

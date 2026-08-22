/** Max characters for a provisional draft / first-message fallback title. */
export const PROVISIONAL_CHAT_TITLE_MAX = 72;

const PLACEHOLDER_CHAT_TITLES = new Set([
  "new chat",
  "start new chat",
  "start a new chat",
  "untitled",
]);

export type ComposerUploadSource = {
  attachments?: readonly unknown[] | null;
  captures?: Record<string, unknown> | null;
  textReferences?: Record<string, unknown> | null;
  linkReferences?: Record<string, unknown> | null;
};

export function collapseTitleText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function truncateProvisionalTitle(
  text: string,
  max = PROVISIONAL_CHAT_TITLE_MAX
): string {
  const collapsed = collapseTitleText(text);
  if (collapsed.length <= max) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(1, max - 1))}…`;
}

export function formatUploadCountTitle(count: number): string {
  if (count <= 0) {
    return "Untitled";
  }
  return count === 1 ? "1 upload" : `${count} uploads`;
}

export function countComposerUploads(source: ComposerUploadSource): number {
  const attachments = source.attachments?.length ?? 0;
  if (attachments > 0) {
    return attachments;
  }
  const captures = source.captures ? Object.keys(source.captures).length : 0;
  if (captures > 0) {
    return captures;
  }
  const texts = source.textReferences ? Object.keys(source.textReferences).length : 0;
  const links = source.linkReferences ? Object.keys(source.linkReferences).length : 0;
  return texts + links;
}

/**
 * Title used while a new-chat composer is saved as a draft, and as the
 * fallback when title generation is unset or fails.
 */
export function formatProvisionalChatTitle(input: {
  text?: string | null;
  attachmentCount?: number;
}): string {
  const verbatim = truncateProvisionalTitle(input.text ?? "");
  if (verbatim) {
    return verbatim;
  }
  return formatUploadCountTitle(input.attachmentCount ?? 0);
}

export function formatProvisionalChatTitleFromComposer(
  source: ComposerUploadSource & { content?: string | null }
): string {
  return formatProvisionalChatTitle({
    text: source.content ?? "",
    attachmentCount: countComposerUploads(source),
  });
}

export function isPlaceholderChatTitle(title: string | null | undefined): boolean {
  const normalized = (title ?? "").trim().toLowerCase();
  return normalized.length === 0 || PLACEHOLDER_CHAT_TITLES.has(normalized);
}

export function isDraftPrefixedChatTitle(title: string | null | undefined): boolean {
  return (title ?? "").startsWith("Draft: ");
}

/**
 * First-prompt title replacement: keep a user rename, replace placeholders
 * and the title we persisted when the composer was saved as a draft.
 */
export function shouldReplaceConversationTitleOnFirstPrompt(
  currentTitle: string,
  expectedTitle?: string | null
): boolean {
  if (isPlaceholderChatTitle(currentTitle) || isDraftPrefixedChatTitle(currentTitle)) {
    return true;
  }
  if (expectedTitle && currentTitle === expectedTitle) {
    return true;
  }
  return false;
}

export function resolveGeneratedOrFallbackTitle(
  generated: string | null | undefined,
  fallback: string
): string {
  const trimmed = generated?.trim() ?? "";
  return trimmed || fallback;
}

export function resolveLandingComposerDraftId(input: {
  standaloneDraftActive: boolean;
  activeWorkspaceId?: string | null;
  activeIsStandaloneChat: boolean;
}): string {
  const noWorkspaceDraft =
    input.standaloneDraftActive ||
    input.activeIsStandaloneChat ||
    !input.activeWorkspaceId;
  return noWorkspaceDraft
    ? "agent-draft:standalone"
    : `agent-draft:${input.activeWorkspaceId}`;
}

export function landingDraftUsesStandaloneWorkspace(input: {
  standaloneDraftActive: boolean;
  activeWorkspaceId?: string | null;
  activeIsStandaloneChat: boolean;
}): boolean {
  if (input.activeIsStandaloneChat && input.activeWorkspaceId) {
    return false;
  }
  return input.standaloneDraftActive || !input.activeWorkspaceId;
}

// Moved to @cesium/core (packages/core/src/link-reference.ts). Re-export shim keeps @/lib/link-reference imports stable.
export {
  COMPOSER_LINK_REFERENCE_TOKEN_REGEX,
  MARKDOWN_HTTP_LINK_REGEX,
  buildLinkMarkdown,
  fallbackTitleFromUrl,
  findComposerLinkReferenceTokens,
  makeComposerLinkReferenceToken,
  sanitizeLinkMarkdownLabel,
  splitContentByMarkdownLinks,
  tryParsePastedLinkUrl,
} from "@cesium/core";
export type {
  LinkReference,
  LinkReferenceStatus,
} from "@cesium/core";

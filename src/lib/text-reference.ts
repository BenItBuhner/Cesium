// Moved to @cesium/core (packages/core/src/text-reference.ts). Re-export shim keeps @/lib/text-reference imports stable.
export {
  COMPOSER_TEXT_REFERENCE_TOKEN_REGEX,
  LONG_PASTE_REFERENCE_THRESHOLD_CHARS,
  TEXT_REFERENCE_BLOCK_REGEX,
  buildTextReferenceBlock,
  findComposerTextReferenceTokens,
  makeComposerTextReferenceToken,
  splitContentByTextReferenceBlocks,
} from "@cesium/core";
export type {
  TextReference,
} from "@cesium/core";

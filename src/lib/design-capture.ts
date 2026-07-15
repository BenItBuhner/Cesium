// Moved to @cesium/core (packages/core/src/design-capture.ts). Re-export shim keeps @/lib/design-capture imports stable.
export {
  COMPOSER_CAPTURE_TOKEN_REGEX,
  DESIGN_CAPTURE_BLOCK_REGEX,
  buildDesignCaptureBlock,
  extractSnippetFromBlockBody,
  findComposerCaptureTokens,
  makeComposerCaptureToken,
  splitContentByDesignBlocks,
} from "@cesium/core";
export type {
  DesignCapture,
  DesignCaptureKind,
} from "@cesium/core";

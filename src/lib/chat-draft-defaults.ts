// Moved to @cesium/client (packages/client/src/composer-defaults.ts): the
// draft defaults are account-wide settings now. Re-export shim keeps existing
// imports stable.
export {
  adoptLegacyComposerFields,
  composerHasNoModelSelection,
  composerModelChoiceSignature,
  createDefaultComposerDefaults,
  extractLegacyComposerFieldsFromChatSession,
  normalizeComposerDefaults,
  resolveLastUsedDraftModel,
  updateComposerDraftDefault,
  updateComposerDraftMode,
  updateComposerDraftProfile,
} from "@cesium/client";
export type {
  ComposerDefaultsState,
  ComposerDraftSelection,
  LegacyChatComposerFields,
} from "@cesium/client";

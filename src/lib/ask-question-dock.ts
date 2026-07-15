// Moved to @cesium/core (packages/core/src/ask-question-dock.ts). Re-export shim keeps @/lib/ask-question-dock imports stable.
export {
  findDockedAskQuestion,
  findLatestPendingQuestionEvent,
  formatAskQuestionSubmission,
  hideDockedAskFromScroll,
  partitionMessagesForAskDock,
  questionEventToChatMessage,
} from "@cesium/core";
export type {
  DockedAskQuestion,
} from "@cesium/core";

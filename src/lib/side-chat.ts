// Shared side-chat helpers live in @cesium/core. Re-export shim keeps @/lib imports stable.
export {
  canOpenSideChat,
  isSideChatConversation,
  listSideChatsOf,
  sideChatOriginOf,
  type SideChatOrigin,
} from "@cesium/core";

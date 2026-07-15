"use client";

import { useEffect, useMemo, useRef } from "react";
import { useAgentConversations } from "@/components/chat/AgentConversationsContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { AGENT_NEW_CHAT_SESSION_ID } from "@/lib/workspace-session";
import { getStoredSessionToken } from "@/lib/auth-client";
import { getConfiguredServerBaseUrl } from "@/lib/configured-server-base-url";
import {
  dispatchMobileBridgeMessage,
  MOBILE_BRIDGE_MESSAGE_EVENT,
  MOBILE_IDLE_CLASS,
  parseMobileBridgeMessage,
  postMobileBridgeMessage,
  type MobileNativeToWebMessage,
} from "@/lib/mobile-bridge";
import {
  deriveMobileAgentProjection,
  type MobileAgentProjection,
} from "@/lib/mobile-agent-projection";
import { toWatchAgentProjection, toWatchSyncEnvelope } from "@/lib/watch-agent-contract";

function readNativeReadyMessage(): MobileNativeToWebMessage | null {
  if (typeof window === "undefined") {
    return null;
  }
  const raw = window.__CESIUM_MOBILE_NATIVE_READY__;
  if (!raw) {
    return null;
  }
  return parseMobileBridgeMessage<MobileNativeToWebMessage>(raw);
}

export function MobileBridgeSync() {
  const {
    activeWorkspaceId,
    flushWorkspaceSessionNow,
    updateWorkspaceSession,
    workspaceSession,
  } = useWorkspace();
  const {
    cancelConversation,
    conversationsById,
    eventsByConversationId,
    flushAgentSubscription,
    syncConversationSnapshot,
  } = useAgentConversations();
  const previousProjectionRef = useRef<MobileAgentProjection | null>(null);
  const activeChatTab = workspaceSession.chat.tabs.find((tab) => tab.active);
  const focusedConversationId = activeChatTab?.id ?? null;
  const focusedConversation =
    focusedConversationId && focusedConversationId !== AGENT_NEW_CHAT_SESSION_ID
      ? conversationsById[focusedConversationId]
      : null;

  const projection = useMemo(() => {
    if (!focusedConversation) {
      return null;
    }
    return deriveMobileAgentProjection(
      focusedConversation,
      eventsByConversationId[focusedConversation.id] ?? [],
      {
        previous: previousProjectionRef.current,
      }
    );
  }, [eventsByConversationId, focusedConversation]);

  useEffect(() => {
    const nativeReady = readNativeReadyMessage();
    if (nativeReady) {
      dispatchMobileBridgeMessage(nativeReady);
    }
  }, []);

  useEffect(() => {
    postMobileBridgeMessage({
      type: "webReady",
      workspaceId: activeWorkspaceId,
      focusedConversationId,
      authToken: getStoredSessionToken(),
    });
  }, [activeWorkspaceId, focusedConversationId]);

  useEffect(() => {
    postMobileBridgeMessage({
      type: "focusedConversationChanged",
      workspaceId: activeWorkspaceId,
      conversationId: focusedConversationId,
      lastEventSeq: projection?.lastEventSeq ?? 0,
    });
  }, [activeWorkspaceId, focusedConversationId, projection?.lastEventSeq]);

  useEffect(() => {
    const serverBaseUrl = getConfiguredServerBaseUrl();
    const watchProjection = projection
      ? toWatchAgentProjection(projection, {
          source: "phone_companion",
        })
      : null;
    postMobileBridgeMessage({
      type: "wearSyncEnvelope",
      envelopeJson: JSON.stringify(
        toWatchSyncEnvelope({
          projection: watchProjection,
          source: "phone_companion",
          server: {
            label: "This device",
            baseUrl: serverBaseUrl,
          },
          focused: {
            workspaceId: activeWorkspaceId,
            conversationId: focusedConversationId,
            lastEventSeq: projection?.lastEventSeq ?? 0,
          },
        })
      ),
      config: {
        serverBaseUrl,
        serverLabel: "This device",
        authToken: getStoredSessionToken(serverBaseUrl),
        workspaceId: activeWorkspaceId,
        conversationId: focusedConversationId,
      },
    });
  }, [activeWorkspaceId, focusedConversationId, projection]);

  useEffect(() => {
    if (!projection) {
      previousProjectionRef.current = null;
      return;
    }
    previousProjectionRef.current = projection;
    postMobileBridgeMessage({
      type: "agentProjection",
      projection,
    });
  }, [projection]);

  useEffect(() => {
    const onNativeMessage = (event: Event) => {
      const message = (event as CustomEvent<MobileNativeToWebMessage>).detail;
      if (!message) {
        return;
      }
      if (message.type === "lifecycle") {
        const idle = message.state !== "active";
        document.documentElement.classList.toggle(MOBILE_IDLE_CLASS, idle);
        postMobileBridgeMessage({ type: "webIdleMode", enabled: idle });
        if (idle) {
          void flushWorkspaceSessionNow().catch(() => undefined);
        } else if (focusedConversationId) {
          flushAgentSubscription([focusedConversationId]);
          void syncConversationSnapshot(focusedConversationId, {
            hydrateRuntime: true,
          }).catch(() => undefined);
        }
        return;
      }

      if (message.type === "notificationAction" && message.actionId === "cancel") {
        const conversationId = message.conversationId ?? focusedConversationId;
        if (!conversationId) {
          return;
        }
        void cancelConversation(conversationId).finally(() => {
          flushAgentSubscription([conversationId]);
          void syncConversationSnapshot(conversationId, {
            hydrateRuntime: true,
          }).catch(() => undefined);
        });
        return;
      }

      if (message.type === "notificationAction" || message.type === "resumeCatchUp") {
        const conversationId = message.conversationId ?? focusedConversationId;
        if (!conversationId) {
          return;
        }
        updateWorkspaceSession((current) => {
          const existing = current.chat.tabs.find((tab) => tab.id === conversationId);
          const nextTabs = current.chat.tabs.map((tab) => ({
            ...tab,
            active: tab.id === conversationId,
          }));
          if (!existing) {
            nextTabs.push({
              id: conversationId,
              title: conversationsById[conversationId]?.title ?? "Conversation",
              active: true,
            });
          }
          return {
            ...current,
            chat: {
              ...current.chat,
              tabs: nextTabs,
            },
          };
        });
        flushAgentSubscription([conversationId]);
        void syncConversationSnapshot(conversationId, {
          hydrateRuntime: true,
        }).catch(() => undefined);
      }
    };

    window.addEventListener(MOBILE_BRIDGE_MESSAGE_EVENT, onNativeMessage);
    return () => {
      window.removeEventListener(MOBILE_BRIDGE_MESSAGE_EVENT, onNativeMessage);
    };
  }, [
    cancelConversation,
    conversationsById,
    flushAgentSubscription,
    flushWorkspaceSessionNow,
    focusedConversationId,
    syncConversationSnapshot,
    updateWorkspaceSession,
  ]);

  return null;
}

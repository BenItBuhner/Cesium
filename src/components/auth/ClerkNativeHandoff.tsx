"use client";

import { useEffect, useRef } from "react";
import { useSignIn } from "@clerk/nextjs";
import {
  activateClerkSessionFromTicket,
  readClerkHandoffTicket,
} from "@/lib/cloud/clerk-native-handoff";
import {
  MOBILE_BRIDGE_MESSAGE_EVENT,
  postMobileBridgeMessage,
  type MobileNativeToWebMessage,
} from "@/lib/mobile-bridge";

type ClerkHandoffMessage = {
  type?: string;
  sessionId?: string | null;
  ticket?: string | null;
  kind?: string | null;
  ok?: boolean;
};

function handoffFromUnknown(value: unknown): ClerkHandoffMessage | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const message = value as ClerkHandoffMessage;
  return message.type === "oauthCompleted" ? message : null;
}

/**
 * Activates a Clerk session in the packaged workbench after the system
 * browser finishes hosted sign-in and returns via cesium://oauth/done.
 */
export function ClerkNativeHandoff() {
  const { signIn } = useSignIn();
  const pendingTicketRef = useRef<string | null>(null);
  const consumingRef = useRef(false);
  // The native shell re-sends unacked OAuth returns (deep links can land
  // before this component mounts), so the same ticket may arrive repeatedly.
  // A ticket that already produced a session must not be redeemed again;
  // failed attempts stay retryable (the failure may have been transient).
  const activatedTicketsRef = useRef(new Set<string>());

  useEffect(() => {
    const consume = async (ticket: string) => {
      if (!signIn) {
        pendingTicketRef.current = ticket;
        return;
      }
      if (consumingRef.current || activatedTicketsRef.current.has(ticket)) {
        return;
      }
      consumingRef.current = true;
      pendingTicketRef.current = null;
      try {
        await activateClerkSessionFromTicket({ signIn }, ticket);
        activatedTicketsRef.current.add(ticket);
      } catch (error) {
        console.error("Failed to activate Clerk session from native handoff", error);
      } finally {
        consumingRef.current = false;
      }
    };

    if (signIn && pendingTicketRef.current) {
      void consume(pendingTicketRef.current);
    }

    const receive = (value: unknown) => {
      const message = handoffFromUnknown(value);
      if (!message) {
        return;
      }
      // Ack every delivery (even failed/foreign ones) so the native shell
      // stops re-sending; a no-op outside the mobile WebView.
      postMobileBridgeMessage({
        type: "oauthCompletedAck",
        sessionId: message.sessionId ?? message.ticket ?? undefined,
      });
      const ticket = readClerkHandoffTicket(message);
      if (!ticket) {
        return;
      }
      void consume(ticket);
    };

    const onBridge = (event: Event) => {
      receive((event as CustomEvent<MobileNativeToWebMessage>).detail);
    };
    const onWindowMessage = (event: MessageEvent) => {
      receive(event.data);
    };

    window.addEventListener(MOBILE_BRIDGE_MESSAGE_EVENT, onBridge);
    window.addEventListener("message", onWindowMessage);
    return () => {
      window.removeEventListener(MOBILE_BRIDGE_MESSAGE_EVENT, onBridge);
      window.removeEventListener("message", onWindowMessage);
    };
  }, [signIn]);

  return null;
}

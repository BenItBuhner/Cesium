"use client";

import { useEffect, useRef } from "react";
import { useSignIn } from "@clerk/nextjs";
import {
  activateClerkSessionFromTicket,
  readClerkHandoffTicket,
} from "@/lib/cloud/clerk-native-handoff";
import {
  MOBILE_BRIDGE_MESSAGE_EVENT,
  type MobileNativeToWebMessage,
} from "@/lib/mobile-bridge";

type ClerkHandoffMessage = {
  type?: string;
  sessionId?: string | null;
  ticket?: string | null;
  kind?: string | null;
  ok?: boolean;
};

function ticketFromUnknown(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const message = value as ClerkHandoffMessage;
  if (message.type !== "oauthCompleted") {
    return null;
  }
  return readClerkHandoffTicket(message);
}

/**
 * Activates a Clerk session in the packaged workbench after the system
 * browser finishes hosted sign-in and returns via cesium://oauth/done.
 */
export function ClerkNativeHandoff() {
  const { isLoaded, signIn, setActive } = useSignIn();
  const pendingTicketRef = useRef<string | null>(null);
  const consumingRef = useRef(false);

  useEffect(() => {
    const consume = async (ticket: string) => {
      if (!signIn || !setActive) {
        pendingTicketRef.current = ticket;
        return;
      }
      if (consumingRef.current) {
        return;
      }
      consumingRef.current = true;
      pendingTicketRef.current = null;
      try {
        await activateClerkSessionFromTicket({ signIn, setActive }, ticket);
      } catch (error) {
        console.error("Failed to activate Clerk session from native handoff", error);
      } finally {
        consumingRef.current = false;
      }
    };

    if (isLoaded && pendingTicketRef.current) {
      void consume(pendingTicketRef.current);
    }

    const onBridge = (event: Event) => {
      const detail = (event as CustomEvent<MobileNativeToWebMessage>).detail;
      const ticket = ticketFromUnknown(detail);
      if (ticket) {
        void consume(ticket);
      }
    };
    const onWindowMessage = (event: MessageEvent) => {
      const ticket = ticketFromUnknown(event.data);
      if (ticket) {
        void consume(ticket);
      }
    };

    window.addEventListener(MOBILE_BRIDGE_MESSAGE_EVENT, onBridge);
    window.addEventListener("message", onWindowMessage);
    return () => {
      window.removeEventListener(MOBILE_BRIDGE_MESSAGE_EVENT, onBridge);
      window.removeEventListener("message", onWindowMessage);
    };
  }, [isLoaded, setActive, signIn]);

  return null;
}

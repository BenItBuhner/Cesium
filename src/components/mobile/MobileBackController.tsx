"use client";

import { useEffect } from "react";
import {
  MOBILE_BRIDGE_MESSAGE_EVENT,
  postMobileBridgeMessage,
  type MobileNativeToWebMessage,
} from "@/lib/mobile-bridge";
import { useBackIntent } from "@/components/mobile/BackIntentContext";

/**
 * Bridges the in-WebView back-intent registry with the native Android shell.
 *
 * - Reports whether the web layer currently has something to pop
 *   (`backCapability`) so the native `BackHandler` can decide between routing
 *   the gesture into the WebView versus walking WebView history / exiting.
 * - Handles `backRequest` from the native predictive/hardware back gesture by
 *   popping the top-most registered layer, replying with `backFallback` when
 *   there is (unexpectedly) nothing left to pop so native can run its default.
 *
 * On the desktop app and plain web the bridge is absent, so
 * `postMobileBridgeMessage` no-ops and `backRequest` never arrives — this
 * component is inert there.
 */
export function MobileBackController() {
  const { canHandleBack, handleBack, subscribe } = useBackIntent();

  useEffect(() => {
    const publishCapability = () => {
      postMobileBridgeMessage({
        type: "backCapability",
        canHandleBack: canHandleBack(),
      });
    };

    publishCapability();
    const unsubscribe = subscribe(publishCapability);

    const onNativeMessage = (event: Event) => {
      const message = (event as CustomEvent<MobileNativeToWebMessage>).detail;
      if (message?.type !== "backRequest") {
        return;
      }
      const handled = handleBack();
      // Re-sync capability: popping a layer usually unregisters its handler.
      publishCapability();
      if (!handled) {
        postMobileBridgeMessage({ type: "backFallback" });
      }
    };

    window.addEventListener(MOBILE_BRIDGE_MESSAGE_EVENT, onNativeMessage);
    return () => {
      unsubscribe();
      window.removeEventListener(MOBILE_BRIDGE_MESSAGE_EVENT, onNativeMessage);
    };
  }, [canHandleBack, handleBack, subscribe]);

  return null;
}

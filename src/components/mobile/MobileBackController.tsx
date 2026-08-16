"use client";

import { useEffect } from "react";
import {
  MOBILE_BRIDGE_MESSAGE_EVENT,
  postMobileBridgeMessage,
  type MobileNativeToWebMessage,
} from "@/lib/mobile-bridge";
import { useBackIntent, type BackGestureEvent } from "@/components/mobile/BackIntentContext";

/**
 * Bridges the in-WebView back-intent registry with the native Android shell.
 *
 * - Reports whether the web layer currently has something to pop
 *   (`backCapability`) so the native side can decide between routing the
 *   gesture into the WebView versus walking WebView history / exiting.
 * - Handles the progressive predictive-back stream (`backStarted` /
 *   `backProgressed` / `backCancelled`) so the top-most registered layer can
 *   track the finger, coalescing progress frames through rAF because the
 *   native side emits at input frequency.
 * - Handles `backRequest` (the gesture commit, also the only message sent by
 *   3-button navigation and older Androids) by popping the gesture's target
 *   layer — or the top-most registered layer when no gesture preceded it —
 *   replying with `backFallback` when there is (unexpectedly) nothing to pop
 *   so native can run its default.
 *
 * On the desktop app and plain web the bridge is absent, so
 * `postMobileBridgeMessage` no-ops and none of these messages arrive — this
 * component is inert there.
 */
export function MobileBackController() {
  const {
    canHandleBack,
    subscribe,
    startBackGesture,
    progressBackGesture,
    cancelBackGesture,
    commitBackGesture,
  } = useBackIntent();

  useEffect(() => {
    const publishCapability = () => {
      postMobileBridgeMessage({
        type: "backCapability",
        canHandleBack: canHandleBack(),
      });
    };

    publishCapability();
    const unsubscribe = subscribe(publishCapability);

    let pendingProgress: BackGestureEvent | null = null;
    let progressFrame: number | null = null;
    const dropPendingProgress = () => {
      pendingProgress = null;
      if (progressFrame !== null) {
        cancelAnimationFrame(progressFrame);
        progressFrame = null;
      }
    };

    const onNativeMessage = (event: Event) => {
      const message = (event as CustomEvent<MobileNativeToWebMessage>).detail;
      if (!message) {
        return;
      }
      if (message.type === "backStarted") {
        dropPendingProgress();
        startBackGesture({
          progress: message.progress,
          swipeEdge: message.swipeEdge,
          touchX: message.touchX,
          touchY: message.touchY,
        });
        return;
      }
      if (message.type === "backProgressed") {
        pendingProgress = {
          progress: message.progress,
          swipeEdge: message.swipeEdge,
          touchX: message.touchX,
          touchY: message.touchY,
        };
        if (progressFrame === null) {
          progressFrame = requestAnimationFrame(() => {
            progressFrame = null;
            if (pendingProgress) {
              progressBackGesture(pendingProgress);
              pendingProgress = null;
            }
          });
        }
        return;
      }
      if (message.type === "backCancelled") {
        dropPendingProgress();
        cancelBackGesture();
        return;
      }
      if (message.type !== "backRequest") {
        return;
      }
      dropPendingProgress();
      const handled = commitBackGesture();
      // Re-sync capability: popping a layer usually unregisters its handler.
      publishCapability();
      if (!handled) {
        postMobileBridgeMessage({ type: "backFallback" });
      }
    };

    window.addEventListener(MOBILE_BRIDGE_MESSAGE_EVENT, onNativeMessage);
    return () => {
      dropPendingProgress();
      unsubscribe();
      window.removeEventListener(MOBILE_BRIDGE_MESSAGE_EVENT, onNativeMessage);
    };
  }, [
    canHandleBack,
    subscribe,
    startBackGesture,
    progressBackGesture,
    cancelBackGesture,
    commitBackGesture,
  ]);

  return null;
}

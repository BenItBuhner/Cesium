"use client";

import { useEffect } from "react";
import {
  USER_PREFERENCES_STORAGE_KEY,
  parseUserPreferences,
  type UserPreferences,
} from "@/lib/preferences";
import { resolveEffectiveUserPreferences } from "@/lib/platform-feature-flags";
import { isCesiumDesktopApp } from "@/lib/desktop-environment";

const IPAD_RESUME_SW_URL = "/ipad-resume-sw.js";
const IPAD_RESUME_SW_CACHE_PREFIX = "opencursor-ipad-resume-";

function readIpadResumeCacheEnabled(): boolean {
  try {
    return resolveEffectiveUserPreferences(
      parseUserPreferences(window.localStorage.getItem(USER_PREFERENCES_STORAGE_KEY))
    ).experimentalIpadResumeCache;
  } catch {
    return false;
  }
}

async function unregisterIpadResumeWorker(): Promise<void> {
  const regs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(
    regs
      .filter((reg) => {
        const scriptUrl =
          reg.active?.scriptURL ?? reg.waiting?.scriptURL ?? reg.installing?.scriptURL ?? "";
        return scriptUrl.endsWith(IPAD_RESUME_SW_URL);
      })
      .map((reg) => reg.unregister())
  );

  if ("caches" in window) {
    const names = await window.caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith(IPAD_RESUME_SW_CACHE_PREFIX))
        .map((name) => window.caches.delete(name))
    );
  }
}

async function unregisterLegacyNextPwaWorker(): Promise<boolean> {
  const regs = await navigator.serviceWorker.getRegistrations();
  const legacyRegs = regs.filter((reg) => {
    const scriptUrl =
      reg.active?.scriptURL ?? reg.waiting?.scriptURL ?? reg.installing?.scriptURL ?? "";
    return scriptUrl.endsWith("/sw.js");
  });
  await Promise.all(legacyRegs.map((reg) => reg.unregister()));
  return legacyRegs.length > 0;
}

export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      return;
    }

    if (!("serviceWorker" in navigator)) {
      return;
    }

    const pwaEnabled = process.env.NEXT_PUBLIC_ENABLE_NEXT_PWA === "1";

    if (!pwaEnabled) {
      // Kill only the old next-pwa worker. Beta cache cleanup is tied to the beta
      // flag below so enabling it cannot race with this startup cleanup.
      void unregisterLegacyNextPwaWorker().then((removedLegacyWorker) => {
        if (navigator.serviceWorker.controller && removedLegacyWorker) {
          const reloadKey = "opencursor:sw-unregistered-reload";
          if (window.sessionStorage.getItem(reloadKey) !== "1") {
            window.sessionStorage.setItem(reloadKey, "1");
            window.location.reload();
          }
        }
      });
    }

    let disposed = false;

    const syncRegistration = () => {
      if (disposed) {
        return;
      }
      if (isCesiumDesktopApp()) {
        void unregisterIpadResumeWorker();
        return;
      }
      if (readIpadResumeCacheEnabled()) {
        void navigator.serviceWorker.register(IPAD_RESUME_SW_URL).catch(() => {
          // Browsers without a generated service worker should fail quietly.
        });
      } else {
        void unregisterIpadResumeWorker();
      }
    };

    if (document.readyState === "complete") {
      syncRegistration();
    } else {
      window.addEventListener("load", syncRegistration, { once: true });
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key === USER_PREFERENCES_STORAGE_KEY) {
        syncRegistration();
      }
    };
    const handlePreferencesChanged = (event: Event) => {
      const preferences = (event as CustomEvent<UserPreferences>).detail;
      if (
        preferences &&
        typeof preferences === "object" &&
        "experimentalIpadResumeCache" in preferences
      ) {
        syncRegistration();
      }
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener("opencursor:user-preferences-changed", handlePreferencesChanged);

    return () => {
      disposed = true;
      window.removeEventListener("load", syncRegistration);
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(
        "opencursor:user-preferences-changed",
        handlePreferencesChanged
      );
    };
  }, []);

  return null;
}

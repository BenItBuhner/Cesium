"use client";

import { useEffect } from "react";

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
      // Kill any older next-pwa registration that may still be controlling the
      // page from a previous build. This keeps localhost from booting stale HTML
      // that references chunk hashes that no longer exist.
      void navigator.serviceWorker.getRegistrations().then((regs) => {
        for (const reg of regs) {
          void reg.unregister();
        }
      });
      return;
    }

    const register = () => {
      void navigator.serviceWorker.register("/sw.js").catch(() => {
        // Browsers without a generated service worker should fail quietly.
      });
    };

    if (document.readyState === "complete") {
      register();
      return;
    }

    window.addEventListener("load", register, { once: true });
    return () => {
      window.removeEventListener("load", register);
    };
  }, []);

  return null;
}

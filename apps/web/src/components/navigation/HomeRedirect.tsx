"use client";

import { useEffect } from "react";

export function HomeRedirect() {
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const target =
      window.location.protocol === "file:"
        ? new URL("./editor/", window.location.href).toString()
        : "/editor";
    window.location.replace(target);
  }, []);

  return null;
}

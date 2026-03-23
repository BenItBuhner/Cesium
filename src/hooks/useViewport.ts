"use client";

import { useState, useEffect } from "react";

export type Breakpoint = "desktop" | "tablet" | "mobile";

export function useViewport() {
  const [width, setWidth] = useState(
    typeof window !== "undefined" ? window.innerWidth : 1920
  );

  useEffect(() => {
    function handleResize() {
      setWidth(window.innerWidth);
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const breakpoint: Breakpoint =
    width >= 1024 ? "desktop" : width >= 768 ? "tablet" : "mobile";

  return {
    width,
    breakpoint,
    showSidebar: width >= 1024,
    showChat: width >= 768,
    isMobile: width < 768,
  };
}

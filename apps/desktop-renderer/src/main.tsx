import React from "react";
import { createRoot } from "react-dom/client";
import { WorkbenchApp } from "@/components/layout/WorkbenchApp";
import { WorkbenchRouteProviders } from "@/components/layout/WorkbenchRouteProviders";
import { initializeRendererRuntime } from "./renderer-runtime";
import "./styles.css";

function DesktopRoot() {
  return (
    <WorkbenchRouteProviders>
      <WorkbenchApp />
    </WorkbenchRouteProviders>
  );
}

void initializeRendererRuntime().finally(() => {
  const root = document.getElementById("root");
  if (!root) {
    throw new Error("Missing root element.");
  }
  createRoot(root).render(
    <React.StrictMode>
      <DesktopRoot />
    </React.StrictMode>
  );
});

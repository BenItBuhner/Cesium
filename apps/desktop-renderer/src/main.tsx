// Must stay the first import: installs built-ins missing from old Android
// System WebViews before any other module executes.
import "./legacy-webview-polyfills";
import React from "react";
import { createRoot } from "react-dom/client";
import { WorkbenchApp } from "@/components/layout/WorkbenchApp";
import { WorkbenchRouteProviders } from "@/components/layout/WorkbenchRouteProviders";
import { CloudProviders } from "@/contexts/CloudContext";
import { initializeRendererRuntime } from "./renderer-runtime";
import { DesktopErrorBoundary } from "./DesktopErrorBoundary";
import "./styles.css";

function DesktopRoot() {
  return (
    // Same cloud provider tree as the Next app's root layout: production
    // cloud behavior by default (build env / committed defaults), runtime
    // local-only switch in Settings → Account.
    <CloudProviders>
      <WorkbenchRouteProviders>
        <WorkbenchApp />
      </WorkbenchRouteProviders>
    </CloudProviders>
  );
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing root element.");
}

createRoot(root).render(
  <React.StrictMode>
    <DesktopErrorBoundary>
      <DesktopRoot />
    </DesktopErrorBoundary>
  </React.StrictMode>
);

void initializeRendererRuntime();

import type { Metadata } from "next";
import { WorkbenchApp } from "@/components/layout/WorkbenchApp";
import { WorkbenchRouteProviders } from "@/components/layout/WorkbenchRouteProviders";

export const metadata: Metadata = {
  title: "Workspace - Cesium",
};

export default function WorkspacePage() {
  return (
    <WorkbenchRouteProviders>
      <WorkbenchApp />
    </WorkbenchRouteProviders>
  );
}

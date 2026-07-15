import type { Metadata } from "next";
import { WorkbenchApp } from "@/components/layout/WorkbenchApp";
import { WorkbenchRouteProviders } from "@/components/layout/WorkbenchRouteProviders";

export const metadata: Metadata = {
  title: "Agent - Cesium",
};

export default function AgentPage() {
  return (
    <WorkbenchRouteProviders>
      <WorkbenchApp />
    </WorkbenchRouteProviders>
  );
}

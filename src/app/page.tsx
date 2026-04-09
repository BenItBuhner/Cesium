import type { Metadata } from "next";
import { WorkbenchApp } from "@/components/layout/WorkbenchApp";
import { WorkbenchProviders } from "@/components/layout/WorkbenchProviders";

export const metadata: Metadata = {
  title: "OpenCursor",
};

export default function Home() {
  return (
    <WorkbenchProviders>
      <WorkbenchApp />
    </WorkbenchProviders>
  );
}

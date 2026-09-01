import type { Metadata } from "next";
import { Suspense } from "react";
import { NativeHandoffBounce } from "@/components/setup/NativeHandoffBounce";
import { SetupWizard } from "@/components/setup/SetupWizard";

export const metadata: Metadata = {
  title: "Set up Cesium",
  description:
    "Connect your first server, set up your agents, import previous work, and start your first conversation.",
};

export default function SetupPage() {
  return (
    <Suspense fallback={null}>
      <NativeHandoffBounce />
      <SetupWizard />
    </Suspense>
  );
}

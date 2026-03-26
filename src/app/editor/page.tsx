import type { Metadata } from "next";
import { IDELayout } from "@/components/layout/IDELayout";
import { WorkspaceProvider } from "@/contexts/WorkspaceContext";

export const metadata: Metadata = {
  title: "Editor · OpenCursor",
};

export default function EditorPage() {
  return (
    <WorkspaceProvider>
      <IDELayout />
    </WorkspaceProvider>
  );
}

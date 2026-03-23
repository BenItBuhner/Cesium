import type { Metadata } from "next";
import { IDELayout } from "@/components/layout/IDELayout";

export const metadata: Metadata = {
  title: "Editor · OpenCursor",
};

export default function EditorPage() {
  return <IDELayout />;
}

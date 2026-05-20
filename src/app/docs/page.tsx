import type { Metadata } from "next";
import { DocsPageView } from "@/components/docs/DocsPageView";

export const metadata: Metadata = {
  title: "Documentation — Cesium",
  description: "How to use Cesium — guides and reference (template).",
};

export default function DocsPage() {
  return <DocsPageView />;
}

import type { Metadata } from "next";
import { LandingPage } from "@/components/landing/LandingPage";

export const metadata: Metadata = {
  title: "Cesium — Local-first AI workbench",
  description:
    "Every agent. Your machine. One workbench. Chat with any coding agent, edit real files, and run real terminals — on your machine, from anywhere.",
};

export default function Home() {
  return <LandingPage />;
}

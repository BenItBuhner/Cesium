import type { Metadata } from "next";
import { LandingPage } from "@/components/landing/LandingPage";

export const metadata: Metadata = {
  title: "Cesium — Local-first AI workbench",
  description:
    "Every agent. Your machine. One workbench. Cesium pairs a deploy-anywhere Next.js client with a Bun-powered engine that runs where your code lives.",
};

export default function Home() {
  return <LandingPage />;
}

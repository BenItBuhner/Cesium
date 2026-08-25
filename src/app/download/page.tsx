import type { Metadata } from "next";
import { DownloadPage } from "@/components/download/DownloadPage";

export const metadata: Metadata = {
  title: "Download Cesium",
  description:
    "Download the Cesium desktop app for macOS, Windows, and Linux, the Android app, or install the engine on your own hardware with one command.",
};

export default function Download() {
  return <DownloadPage />;
}

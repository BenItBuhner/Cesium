import type { Metadata } from "next";
import Link from "next/link";
import { WORKSPACE_ROUTE } from "@/lib/workbench-view";

export const metadata: Metadata = {
  title: "Cesium",
  description: "Open-source AI coding workbench.",
};

export default function Home() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-[var(--bg-main)] text-[var(--text-primary)]">
      <Link
        href={WORKSPACE_ROUTE}
        className="rounded border border-[var(--border-card)] bg-[var(--bg-panel)] px-4 py-2 font-sans text-[14px] text-[var(--text-primary)] hover:bg-[var(--bg-card-hover)]"
      >
        Open agent
      </Link>
    </main>
  );
}

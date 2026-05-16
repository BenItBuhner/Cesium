import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight, Code2, MessagesSquare, PanelsTopLeft, TerminalSquare } from "lucide-react";
import { WORKSPACE_ROUTE } from "@/lib/workbench-view";

export const metadata: Metadata = {
  title: "Cesium - Open-source AI IDE",
  description:
    "Cesium is an open-source AI-powered IDE for agentic coding, editing, terminals, and browser workflows.",
};

export default function Home() {
  return (
    <main className="min-h-dvh overflow-hidden bg-[var(--bg-main)] text-[var(--text-primary)]">
      <section className="mx-auto flex min-h-dvh w-full max-w-[1120px] flex-col px-6 py-6 sm:px-8 lg:px-10">
        <nav className="flex items-center justify-between gap-4">
          <Link
            href="/"
            className="inline-flex items-center gap-2 font-sans text-[14px] font-semibold tracking-tight"
            aria-label="Cesium home"
          >
            <span className="flex size-7 items-center justify-center rounded-[8px] border border-[var(--border-card)] bg-[var(--bg-panel)]">
              <Code2 className="size-4" strokeWidth={1.8} aria-hidden />
            </span>
            Cesium
          </Link>
          <div className="flex items-center gap-2">
            <Link
              href="/docs"
              className="rounded-[var(--radius-pill)] px-3 py-2 font-sans text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
            >
              Docs
            </Link>
            <Link
              href={WORKSPACE_ROUTE}
              className="inline-flex items-center gap-2 rounded-[var(--radius-pill)] border border-[var(--border-card)] bg-[var(--text-primary)] px-4 py-2 font-sans text-[13px] font-medium text-[var(--bg-main)] transition-opacity hover:opacity-90"
            >
              Open workspace
              <ArrowRight className="size-4" strokeWidth={1.8} aria-hidden />
            </Link>
          </div>
        </nav>

        <div className="grid flex-1 items-center gap-12 py-14 lg:grid-cols-[1fr_0.92fr] lg:py-20">
          <div className="max-w-[680px]">
            <p className="mb-4 inline-flex rounded-[var(--radius-pill)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-3 py-1 font-sans text-[12px] text-[var(--text-secondary)]">
              Open-source AI coding workspace
            </p>
            <h1 className="font-sans text-[46px] font-semibold leading-[0.98] tracking-[-0.045em] sm:text-[64px] lg:text-[76px]">
              Your agent, editor, terminal, and browser in one open workbench.
            </h1>
            <p className="mt-6 max-w-[600px] font-sans text-[16px] leading-[1.7] text-[var(--text-secondary)] sm:text-[18px]">
              Cesium brings agentic coding into a local-first IDE surface, with
              workspace-aware conversations, editor context, terminals, browser tools,
              and project state designed to stay inspectable.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href={WORKSPACE_ROUTE}
                className="inline-flex h-11 items-center gap-2 rounded-[var(--radius-pill)] bg-[var(--text-primary)] px-5 font-sans text-[14px] font-medium text-[var(--bg-main)] transition-opacity hover:opacity-90"
              >
                Launch workspace
                <ArrowRight className="size-4" strokeWidth={1.8} aria-hidden />
              </Link>
              <Link
                href="/docs"
                className="inline-flex h-11 items-center rounded-[var(--radius-pill)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-5 font-sans text-[14px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-card-hover)]"
              >
                Read docs
              </Link>
            </div>
          </div>

          <div className="relative min-h-[420px] rounded-[28px] border border-[var(--border-card)] bg-[var(--bg-panel)] p-3 shadow-[0_30px_120px_rgba(0,0,0,0.18)]">
            <div className="flex h-full min-h-[396px] flex-col overflow-hidden rounded-[20px] border border-[var(--border-card)] bg-[var(--bg-main)]">
              <div className="flex h-10 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] px-4">
                <span className="size-2.5 rounded-full bg-[var(--debug-accent)]" />
                <span className="size-2.5 rounded-full bg-[var(--plan-accent)]" />
                <span className="size-2.5 rounded-full bg-[var(--ask-accent)]" />
                <span className="ml-2 font-mono text-[11px] text-[var(--text-disabled)]">
                  /workspace
                </span>
              </div>
              <div className="grid flex-1 grid-cols-[0.9fr_1.35fr]">
                <div className="border-r border-[var(--border-subtle)] bg-[var(--bg-panel)] p-4">
                  <FeaturePill icon={<MessagesSquare className="size-4" />} label="Agent threads" />
                  <FeaturePill icon={<PanelsTopLeft className="size-4" />} label="Editor context" />
                  <FeaturePill icon={<TerminalSquare className="size-4" />} label="Terminals" />
                </div>
                <div className="flex flex-col gap-3 p-4">
                  <div className="rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] p-4">
                    <p className="font-sans text-[12px] font-medium text-[var(--text-primary)]">
                      Agent workspace
                    </p>
                    <p className="mt-2 font-sans text-[12px] leading-5 text-[var(--text-secondary)]">
                      Plan, edit, test, and inspect changes without losing the file,
                      terminal, and browser context that made them happen.
                    </p>
                  </div>
                  <div className="grid flex-1 grid-cols-2 gap-3">
                    <PreviewPanel title="Editor" lines={5} />
                    <PreviewPanel title="Terminal" lines={4} />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

function FeaturePill({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="mb-3 flex items-center gap-3 rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-main)] px-3 py-3 font-sans text-[13px] text-[var(--text-primary)]">
      <span className="text-[var(--text-secondary)]">{icon}</span>
      {label}
    </div>
  );
}

function PreviewPanel({ title, lines }: { title: string; lines: number }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] p-3">
      <p className="mb-3 font-mono text-[11px] text-[var(--text-disabled)]">{title}</p>
      <div className="space-y-2">
        {Array.from({ length: lines }, (_, index) => (
          <div
            key={index}
            className="h-2 rounded-full bg-[var(--border-card)]"
            style={{ width: `${92 - index * 11}%` }}
          />
        ))}
      </div>
    </div>
  );
}

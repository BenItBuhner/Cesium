import Link from "next/link";
import { ArrowLeft, BookOpen, Keyboard, MessageSquare, Terminal } from "lucide-react";
import { WORKSPACE_ROUTE } from "@/lib/workbench-view";

const sections = [
  {
    icon: BookOpen,
    title: "Getting started",
    body: "Overview of the workspace, editor, and chat. You'll wire real copy here when the product flow is final.",
  },
  {
    icon: Keyboard,
    title: "Keyboard & commands",
    body: "Document shortcuts, the command palette, and quick-open. Placeholder until bindings are listed in one place.",
  },
  {
    icon: MessageSquare,
    title: "Agent & chat",
    body: "Explain modes, models, and how threads work. Swap this blurb for concrete steps and screenshots later.",
  },
  {
    icon: Terminal,
    title: "Terminal & tools",
    body: "Optional section for shell integration, MCP, or task running — template only for now.",
  },
] as const;

export function DocsPageView() {
  return (
    <div className="fixed inset-0 z-0 overflow-x-hidden overflow-y-auto bg-[var(--bg-main)]">
      <div className="mx-auto min-h-full max-w-[720px] px-[24px] py-[40px] pb-[72px] sm:px-[32px] sm:py-[56px]">
        <nav className="mb-[32px] flex flex-wrap items-center justify-between gap-[16px]">
          <Link
            href={WORKSPACE_ROUTE}
            className="inline-flex items-center gap-[8px] rounded-[var(--radius-tab)] px-[10px] py-[6px] font-sans text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
          >
            <ArrowLeft className="size-[14px] shrink-0" strokeWidth={1.5} aria-hidden />
            Back to agent
          </Link>
          <span className="font-sans text-[12px] text-[var(--text-disabled)]">Cesium</span>
        </nav>

        <header className="mb-[40px]">
          <p className="mb-[8px] font-sans text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-disabled)]">
            Documentation
          </p>
          <h1 className="font-sans text-[28px] font-semibold leading-tight tracking-tight text-[var(--text-primary)] sm:text-[32px]">
            How to use Cesium
          </h1>
          <p className="mt-[14px] max-w-[560px] font-sans text-[15px] leading-relaxed text-[var(--text-secondary)]">
            This is a layout template: same typography and tokens as the IDE. Replace sections with real guides when
            you&apos;re ready.
          </p>
        </header>

        <div className="mb-[36px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] p-[20px] sm:p-[24px]">
          <h2 className="font-sans text-[13px] font-semibold uppercase tracking-wide text-[var(--text-disabled)]">
            Quick reference
          </h2>
          <dl className="mt-[16px] space-y-[12px] font-sans text-[13px]">
            <div className="flex flex-col gap-[4px] sm:flex-row sm:items-baseline sm:gap-[16px]">
              <dt className="shrink-0 font-medium text-[var(--text-primary)]">Command palette</dt>
              <dd className="text-[var(--text-secondary)]">
                <kbd className="rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[8px] py-[3px] font-mono text-[12px] text-[var(--text-primary)]">
                  Ctrl
                </kbd>
                <span className="mx-[4px] text-[var(--text-disabled)]">+</span>
                <kbd className="rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[8px] py-[3px] font-mono text-[12px] text-[var(--text-primary)]">
                  Shift
                </kbd>
                <span className="mx-[4px] text-[var(--text-disabled)]">+</span>
                <kbd className="rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[8px] py-[3px] font-mono text-[12px] text-[var(--text-primary)]">
                  P
                </kbd>
                <span className="ml-[8px]">placeholder — set your real shortcut</span>
              </dd>
            </div>
            <div className="flex flex-col gap-[4px] sm:flex-row sm:items-baseline sm:gap-[16px]">
              <dt className="shrink-0 font-medium text-[var(--text-primary)]">Settings</dt>
              <dd className="text-[var(--text-secondary)]">
                <kbd className="rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[8px] py-[3px] font-mono text-[12px] text-[var(--text-primary)]">
                  Ctrl
                </kbd>
                <span className="mx-[4px] text-[var(--text-disabled)]">+</span>
                <kbd className="rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[8px] py-[3px] font-mono text-[12px] text-[var(--text-primary)]">
                  ,
                </kbd>
                <span className="ml-[8px]">when focused in the app</span>
              </dd>
            </div>
          </dl>
        </div>

        <div className="space-y-[16px]">
          {sections.map(({ icon: Icon, title, body }) => (
            <section
              key={title}
              className="rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-[20px] transition-colors hover:border-[var(--border-card)] sm:p-[24px]"
            >
              <div className="flex gap-[14px]">
                <div
                  className="flex size-[40px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] text-[var(--text-secondary)]"
                  aria-hidden
                >
                  <Icon className="size-[20px]" strokeWidth={1.5} />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="font-sans text-[17px] font-semibold tracking-tight text-[var(--text-primary)]">
                    {title}
                  </h2>
                  <p className="mt-[8px] font-sans text-[14px] leading-relaxed text-[var(--text-secondary)]">{body}</p>
                </div>
              </div>
            </section>
          ))}
        </div>

        <footer className="mt-[48px] border-t border-[var(--border-subtle)] pt-[24px]">
          <p className="font-sans text-[12px] leading-relaxed text-[var(--text-disabled)]">
            Template page — add MDX, search, or sidebar navigation when you outgrow this single column.
          </p>
        </footer>
      </div>
    </div>
  );
}

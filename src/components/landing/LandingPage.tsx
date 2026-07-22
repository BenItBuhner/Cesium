import Link from "next/link";
import type { CSSProperties } from "react";
import {
  ArrowRight,
  BookOpen,
  Cloud,
  Cpu,
  Database,
  FolderOpen,
  Globe,
  MessagesSquare,
  Mic,
  Monitor,
  ShieldCheck,
  Smartphone,
  SquareCode,
  Tablet,
  TerminalSquare,
} from "lucide-react";
import { WORKSPACE_ROUTE } from "@/lib/workbench-view";

/* ------------------------------------------------------------------------ */
/* Shared bits                                                              */
/* ------------------------------------------------------------------------ */

/** Rounded-hexagon Cesium mark (from `public/icon-source.svg`), currentColor. */
function CesiumMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 174" className={className} aria-hidden>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M159.014 134.928L112 162.072a24 24 0 0 1-24 0l-47.014-27.144a24 24 0 0 1-12-20.784V59.856a24 24 0 0 1 12-20.784L88 11.928a24 24 0 0 1 24 0l47.014 27.144a24 24 0 0 1 12 20.784v54.288a24 24 0 0 1-12 20.784ZM151.014 121.072L104 148.215a8 8 0 0 1-8 0l-47.014-27.143a8 8 0 0 1-4-6.928V59.856a8 8 0 0 1 4-6.928L96 25.785a8 8 0 0 1 8 0l47.014 27.143a8 8 0 0 1 4 6.928v54.288a8 8 0 0 1-4 6.928Z"
      />
    </svg>
  );
}

/**
 * Agent brand mark painted as a `currentColor` mask so it stays monochrome
 * and readable in both themes (same trick as `AgentBackendIcon` tone="text").
 */
function AgentMask({ file, className }: { file: string; className?: string }) {
  const url = `url("/agent-backend-icons/${encodeURIComponent(file)}")`;
  const style: CSSProperties = {
    backgroundColor: "currentColor",
    WebkitMaskImage: url,
    maskImage: url,
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
    WebkitMaskPosition: "center",
    maskPosition: "center",
    WebkitMaskSize: "contain",
    maskSize: "contain",
  };
  return <span aria-hidden className={`inline-block shrink-0 ${className ?? ""}`} style={style} />;
}

function SectionLabel({ index, children }: { index: string; children: React.ReactNode }) {
  return (
    <p className="mb-[10px] font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-disabled)]">
      <span className="text-[var(--text-secondary)]">{index}</span>
      <span className="mx-[8px]">·</span>
      {children}
    </p>
  );
}

/** Periodic-table tile for caesium — the brand's namesake. */
function ElementTile() {
  return (
    <div className="relative">
      {/* offset "shadow" tile */}
      <div
        className="absolute inset-0 translate-x-[10px] translate-y-[10px] rounded-[var(--radius-card)] border border-[var(--border-subtle)]"
        aria-hidden
      />
      <div className="relative flex w-[228px] flex-col rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] p-[20px] shadow-[0_16px_48px_-24px_rgba(0,0,0,0.3)]">
        <div className="flex items-baseline justify-between font-mono text-[12px] text-[var(--text-secondary)]">
          <span>55</span>
          <span>132.905</span>
        </div>
        <div className="py-[10px] text-center text-[92px] font-semibold leading-none tracking-tight text-[var(--text-primary)]">
          Cs
        </div>
        <div className="text-center font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--text-disabled)]">
          caesium
        </div>
        <div className="mt-[14px] border-t border-[var(--border-subtle)] pt-[12px] text-center font-mono text-[10.5px] leading-relaxed text-[var(--text-secondary)]">
          the element that defines the second
        </div>
      </div>
    </div>
  );
}

/**
 * Real product screenshot (not a mockup): a Cesium agent tracing this repo's
 * WebSocket reconnect logic. Light/dark variants swap with `html.dark`.
 */
function WorkbenchShot() {
  return (
    <figure className="mx-auto max-w-[980px]">
      <div className="overflow-hidden rounded-[14px] border border-[var(--border-card)] bg-[var(--bg-panel)] shadow-[0_24px_80px_-24px_rgba(0,0,0,0.35)]">
        <div className="flex items-center gap-[8px] border-b border-[var(--border-subtle)] bg-[var(--bg-main)] px-[14px] py-[10px]">
          <span className="size-[10px] rounded-full bg-[var(--burn-accent)] opacity-80" />
          <span className="size-[10px] rounded-full bg-[var(--plan-accent)] opacity-80" />
          <span className="size-[10px] rounded-full bg-[var(--ask-accent)] opacity-80" />
          <span className="ml-[10px] font-mono text-[11px] text-[var(--text-disabled)]">
            cesium — /agent · glm-5.2
          </span>
        </div>
        <img
          src="/landing/workbench-light.webp"
          alt="Cesium workbench, light theme: an agent conversation tracing WebSocket reconnect logic with tool calls and a backoff table"
          width={1280}
          height={772}
          className="landing-shot-light block w-full"
        />
        <img
          src="/landing/workbench-dark.webp"
          alt="Cesium workbench, dark theme: an agent conversation tracing WebSocket reconnect logic with tool calls and a backoff table"
          width={1280}
          height={772}
          className="landing-shot-dark w-full"
        />
      </div>
      <figcaption className="mt-[14px] text-center font-mono text-[11.5px] text-[var(--text-disabled)]">
        Not a mockup — a live session. A Cesium agent tracing the WebSocket reconnect logic in
        this very repository.
      </figcaption>
    </figure>
  );
}

/* ------------------------------------------------------------------------ */
/* Content data                                                             */
/* ------------------------------------------------------------------------ */

const AGENT_MARQUEE = [
  { name: "Cursor", file: "Cursor-Light.svg", note: "SDK + ACP" },
  { name: "Codex", file: "Codex-Light.svg", note: "app server" },
  { name: "Claude Code", file: "Claude-Code-Light.svg", note: "SDK" },
  { name: "OpenCode", file: "OpenCode-Light.svg", note: "ACP" },
  { name: "Devin", file: "Devin-Light.svg", note: "ACP" },
  { name: "Gemini CLI", file: "Gemini-CLI-Light.svg", note: "ACP" },
] as const;

const FEATURES = [
  {
    icon: MessagesSquare,
    title: "Agent conversations",
    body: "Long-lived agent chats with streaming output, tool-call approvals, and history that survives restarts — all live over WebSockets.",
    accent: "var(--orchestration-accent)",
    accentBg: "var(--orchestration-accent-bg)",
  },
  {
    icon: SquareCode,
    title: "A real IDE, in the browser",
    body: "Monaco editor, file tree, tabs, and a live file watcher — editing the actual folders on your disk, not a sandboxed copy.",
    accent: "var(--workflow-accent)",
    accentBg: "var(--workflow-accent-bg)",
  },
  {
    icon: TerminalSquare,
    title: "Integrated terminals",
    body: "Real PTY sessions streamed to xterm.js. Watch what your agents run, scroll back through it, and take over whenever you want.",
    accent: "var(--burn-accent)",
    accentBg: "var(--burn-accent-bg)",
  },
  {
    icon: FolderOpen,
    title: "Workspaces on your terms",
    body: "Register real directories and switch between them instantly. Allow-listed roots keep access scoped to folders you chose.",
    accent: "var(--plan-accent)",
    accentBg: "var(--plan-accent-bg)",
  },
  {
    icon: Mic,
    title: "Voice input",
    body: "Dictate prompts through any OpenAI-compatible transcription endpoint. Configure it once and talk to your codebase.",
    accent: "var(--ask-accent)",
    accentBg: "var(--ask-accent-bg)",
  },
  {
    icon: Database,
    title: "Storage that scales with you",
    body: "Plain JSON files out of the box — no services to run. Flip one variable for Postgres + Redis, and migrate either direction any time.",
    accent: "var(--debug-accent)",
    accentBg: "var(--debug-accent-bg)",
  },
] as const;

const PLATFORMS = [
  {
    icon: Globe,
    title: "Web",
    body: "Any modern browser, installable as a PWA. This is the client you deploy to Vercel.",
  },
  {
    icon: Monitor,
    title: "Desktop",
    body: "A native Electron app sharing the same renderer, for a windowed local workbench.",
  },
  {
    icon: Smartphone,
    title: "Mobile",
    body: "A native Android workbench built with React Native — your agents, pocket-sized.",
  },
  {
    icon: Tablet,
    title: "Tablet",
    body: "A dedicated iPad mode with touch-tuned layout, window chrome, and resume cache.",
  },
] as const;

/* ------------------------------------------------------------------------ */
/* Architecture diagram                                                     */
/* ------------------------------------------------------------------------ */

function ArchitectureDiagram() {
  return (
    <div className="grid grid-cols-1 items-stretch gap-[16px] md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
      <div className="rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] p-[24px]">
        <div className="mb-[14px] flex items-center gap-[10px]">
          <span className="flex size-[36px] items-center justify-center rounded-[var(--radius-tab)] bg-[var(--accent-bg)] text-[var(--text-primary)]">
            <Cloud className="size-[18px]" strokeWidth={1.5} aria-hidden />
          </span>
          <div>
            <h3 className="text-[15px] font-semibold tracking-tight text-[var(--text-primary)]">The client</h3>
            <p className="font-mono text-[11px] text-[var(--text-disabled)]">Next.js 16 · deploy to Vercel</p>
          </div>
        </div>
        <ul className="space-y-[8px] text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
          <li>Static-first React 19 app — nothing sensitive lives here.</li>
          <li>Installable PWA; one env var points it at your engine.</li>
          <li>Open it from a laptop, a phone, or a tablet on the go.</li>
        </ul>
      </div>

      <div className="flex items-center justify-center md:flex-col">
        <div className="flex w-full items-center gap-[10px] md:h-full md:w-auto md:flex-col">
          <span className="landing-wire-y hidden h-full min-h-[40px] w-[2px] md:block" />
          <span className="landing-wire-x block h-[2px] w-full min-w-[40px] md:hidden" />
          <span className="whitespace-nowrap rounded-[var(--radius-pill)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[12px] py-[5px] font-mono text-[10.5px] text-[var(--text-secondary)]">
            REST + WebSockets
          </span>
          <span className="landing-wire-y hidden h-full min-h-[40px] w-[2px] md:block" />
          <span className="landing-wire-x block h-[2px] w-full min-w-[40px] md:hidden" />
        </div>
      </div>

      <div className="rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] p-[24px]">
        <div className="mb-[14px] flex items-center gap-[10px]">
          <span className="flex size-[36px] items-center justify-center rounded-[var(--radius-tab)] bg-[var(--accent-bg)] text-[var(--text-primary)]">
            <Cpu className="size-[18px]" strokeWidth={1.5} aria-hidden />
          </span>
          <div>
            <h3 className="text-[15px] font-semibold tracking-tight text-[var(--text-primary)]">The engine</h3>
            <p className="font-mono text-[11px] text-[var(--text-disabled)]">Bun + Hono · runs with your code</p>
          </div>
        </div>
        <ul className="space-y-[8px] text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
          <li>Files, terminals, and agent CLIs never leave your machine.</li>
          <li>Session auth and rate limits when you expose it beyond localhost.</li>
          <li>JSON storage by default; Postgres + Redis when you scale.</li>
        </ul>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Page                                                                     */
/* ------------------------------------------------------------------------ */

export function LandingPage() {
  const marqueeItems = [...AGENT_MARQUEE, ...AGENT_MARQUEE];

  return (
    <div className="fixed inset-0 z-0 overflow-y-auto overflow-x-hidden bg-[var(--bg-main)] text-[var(--text-primary)]">
      {/* nav */}
      <header className="sticky top-0 z-20 border-b border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-main)_82%,transparent)] backdrop-blur-md">
        <div className="mx-auto flex h-[56px] max-w-[1100px] items-center justify-between px-[24px]">
          <div className="flex items-center gap-[10px]">
            <CesiumMark className="h-[22px] w-auto text-[var(--text-primary)]" />
            <span className="text-[15px] font-semibold tracking-tight">Cesium</span>
          </div>
          <nav className="flex items-center gap-[6px]">
            <Link
              href="/docs"
              className="rounded-[var(--radius-tab)] px-[12px] py-[6px] text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
            >
              Docs
            </Link>
            <Link
              href={WORKSPACE_ROUTE}
              className="rounded-[var(--radius-tab)] bg-[var(--accent)] px-[14px] py-[6px] text-[13px] font-medium text-[var(--bg-main)] transition-colors hover:bg-[var(--accent-dark)]"
            >
              Launch workbench
            </Link>
          </nav>
        </div>
      </header>

      {/* hero */}
      <section className="relative">
        <div className="landing-grid-bg pointer-events-none absolute inset-0" aria-hidden />
        <div className="relative mx-auto max-w-[1100px] px-[24px] pb-[64px] pt-[64px] sm:pt-[88px]">
          <div className="grid grid-cols-1 items-center gap-[48px] lg:grid-cols-[minmax(0,1fr)_auto]">
            <div>
              <p className="mb-[20px] inline-flex items-center gap-[8px] rounded-[var(--radius-pill)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[14px] py-[6px] font-mono text-[11px] text-[var(--text-secondary)]">
                <span className="size-[6px] rounded-full bg-[var(--ask-accent)]" />
                Local-first AI workbench
              </p>
              <h1 className="text-balance text-[42px] font-semibold leading-[1.05] tracking-tight sm:text-[58px]">
                Every agent.
                <br />
                Your machine.
                <br />
                One workbench.
              </h1>
              <p className="mt-[22px] max-w-[520px] text-pretty text-[16px] leading-relaxed text-[var(--text-secondary)]">
                Cesium pairs a Next.js client you can put on Vercel with a Bun-powered engine that
                runs where your code lives. Chat with any coding agent, edit real files, run real
                terminals — from anywhere.
              </p>
              <div className="mt-[32px] flex flex-wrap items-center gap-[12px]">
                <Link
                  href={WORKSPACE_ROUTE}
                  className="inline-flex items-center gap-[8px] rounded-[var(--radius-tab)] bg-[var(--accent)] px-[20px] py-[10px] text-[14px] font-medium text-[var(--bg-main)] transition-colors hover:bg-[var(--accent-dark)]"
                >
                  Launch the workbench
                  <ArrowRight className="size-[15px]" strokeWidth={2} aria-hidden />
                </Link>
                <Link
                  href="/docs"
                  className="inline-flex items-center gap-[8px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[20px] py-[10px] text-[14px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-card-hover)]"
                >
                  <BookOpen className="size-[15px]" strokeWidth={1.75} aria-hidden />
                  Read the docs
                </Link>
              </div>
              <p className="mt-[18px] font-mono text-[11.5px] text-[var(--text-disabled)]">
                npm run dev · npm run dev:server · open localhost:3000
              </p>
            </div>
            <div className="hidden justify-center lg:flex lg:rotate-[2.5deg] lg:pr-[10px]">
              <ElementTile />
            </div>
          </div>

          <div className="mt-[56px]">
            <WorkbenchShot />
          </div>
        </div>
      </section>

      {/* agent marquee */}
      <section className="border-y border-[var(--border-subtle)] bg-[var(--bg-panel)] py-[28px]">
        <p className="mb-[18px] text-center font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--text-disabled)]">
          Speaks fluent agent — SDK, ACP, and CLI adapters included
        </p>
        <div className="landing-marquee overflow-hidden">
          <div className="landing-marquee-track flex w-max items-center">
            {marqueeItems.map(({ name, file, note }, i) => (
              <span
                key={`${name}-${i}`}
                className="mx-[26px] inline-flex items-center gap-[10px] text-[var(--text-secondary)]"
              >
                <AgentMask file={file} className="size-[20px]" />
                <span className="whitespace-nowrap text-[14px] font-medium">{name}</span>
                <span className="whitespace-nowrap font-mono text-[10.5px] text-[var(--text-disabled)]">{note}</span>
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* atomic interlude */}
      <section className="mx-auto max-w-[1100px] px-[24px] pt-[72px]">
        <div className="mx-auto max-w-[720px] text-center">
          <p className="font-mono text-[26px] font-medium tracking-tight text-[var(--text-primary)] sm:text-[36px]">
            9,192,631,770
          </p>
          <p className="mt-[10px] text-[14.5px] leading-relaxed text-[var(--text-secondary)]">
            oscillations of a caesium-133 atom define one second. We named the workbench after the
            element that keeps time itself honest — every agent event, tool call, and terminal
            byte is streamed live and persisted, so nothing your agents do goes unaccounted for.
          </p>
        </div>
      </section>

      {/* features */}
      <section className="mx-auto max-w-[1100px] px-[24px] py-[72px]">
        <div className="mb-[36px] max-w-[560px]">
          <SectionLabel index="01">Versatility</SectionLabel>
          <h2 className="text-[28px] font-semibold leading-tight tracking-tight sm:text-[32px]">
            A full workbench, not another chat box
          </h2>
          <p className="mt-[12px] text-[15px] leading-relaxed text-[var(--text-secondary)]">
            Everything an agent needs to do real work — and everything you need to supervise it —
            lives in one window.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-[16px] sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, body, accent, accentBg }) => (
            <article
              key={title}
              className="rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-[22px] transition-colors hover:border-[var(--border-card)]"
            >
              <span
                className="mb-[16px] flex size-[38px] items-center justify-center rounded-[var(--radius-tab)]"
                style={{ backgroundColor: accentBg, color: accent }}
              >
                <Icon className="size-[19px]" strokeWidth={1.5} aria-hidden />
              </span>
              <h3 className="text-[15.5px] font-semibold tracking-tight text-[var(--text-primary)]">{title}</h3>
              <p className="mt-[8px] text-[13.5px] leading-relaxed text-[var(--text-secondary)]">{body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* hybrid architecture */}
      <section className="border-y border-[var(--border-subtle)] bg-[var(--bg-panel)]">
        <div className="mx-auto max-w-[1100px] px-[24px] py-[72px]">
          <div className="mb-[36px] max-w-[600px]">
            <SectionLabel index="02">Hybrid architecture</SectionLabel>
            <h2 className="text-[28px] font-semibold leading-tight tracking-tight sm:text-[32px]">
              Cloud reach. Local roots.
            </h2>
            <p className="mt-[12px] text-[15px] leading-relaxed text-[var(--text-secondary)]">
              The client is just a window — deploy it once and open it from anywhere. The engine is
              the workshop, and it stays on hardware you control. Your source never has to leave
              home to get cloud convenience.
            </p>
          </div>
          <ArchitectureDiagram />
        </div>
      </section>

      {/* interoperability */}
      <section className="mx-auto max-w-[1100px] px-[24px] py-[72px]">
        <div className="grid grid-cols-1 items-center gap-[40px] lg:grid-cols-2">
          <div>
            <SectionLabel index="03">Multi-agent interoperability</SectionLabel>
            <h2 className="text-[28px] font-semibold leading-tight tracking-tight sm:text-[32px]">
              One conversation, many minds
            </h2>
            <p className="mt-[12px] max-w-[480px] text-[15px] leading-relaxed text-[var(--text-secondary)]">
              Backends are interchangeable mid-thread. Start a task with one harness, hand the
              conversation off to another with context intact, and pick models across providers
              from a single composer. Tool permissions are approved by you, per call, whichever
              agent is driving.
            </p>
            <ul className="mt-[20px] space-y-[10px] text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
              <li className="flex items-start gap-[10px]">
                <ShieldCheck className="mt-[2px] size-[15px] shrink-0 text-[var(--ask-accent)]" strokeWidth={1.75} aria-hidden />
                Per-tool permission prompts, whichever backend is active.
              </li>
              <li className="flex items-start gap-[10px]">
                <ArrowRight className="mt-[2px] size-[15px] shrink-0 text-[var(--orchestration-accent)]" strokeWidth={1.75} aria-hidden />
                Context handoff carries recent messages to the next agent.
              </li>
              <li className="flex items-start gap-[10px]">
                <Cpu className="mt-[2px] size-[15px] shrink-0 text-[var(--workflow-accent)]" strokeWidth={1.75} aria-hidden />
                Bring your own keys and CLIs — Cesium orchestrates, you own the accounts.
              </li>
            </ul>
          </div>

          {/* handoff visual */}
          <div className="rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] p-[26px]">
            <p className="mb-[18px] font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--text-disabled)]">
              Handoff, mid-thread
            </p>
            <div className="space-y-[14px]">
              {(
                [
                  { name: "Cursor", file: "Cursor-Light.svg", task: "scaffolds the migration plan" },
                  { name: "Claude Code", file: "Claude-Code-Light.svg", task: "implements and edits files" },
                  { name: "Codex", file: "Codex-Light.svg", task: "reviews the diff and runs tests" },
                ] as const
              ).map(({ name, file, task }, i, arr) => (
                <div key={name}>
                  <div className="flex items-center gap-[12px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-card)] px-[14px] py-[11px]">
                    <AgentMask file={file} className="size-[18px] text-[var(--text-primary)]" />
                    <span className="text-[13.5px] font-medium text-[var(--text-primary)]">{name}</span>
                    <span className="ml-auto truncate text-[12px] text-[var(--text-secondary)]">{task}</span>
                  </div>
                  {i < arr.length - 1 ? (
                    <div className="flex items-center gap-[8px] py-[8px] pl-[20px]">
                      <span className="landing-wire-y h-[16px] w-[2px]" />
                      <span className="font-mono text-[10.5px] text-[var(--text-disabled)]">
                        handoff · context carried over
                      </span>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* platforms */}
      <section className="border-y border-[var(--border-subtle)] bg-[var(--bg-panel)]">
        <div className="mx-auto max-w-[1100px] px-[24px] py-[72px]">
          <div className="mb-[36px] max-w-[560px]">
            <SectionLabel index="04">Platform support</SectionLabel>
            <h2 className="text-[28px] font-semibold leading-tight tracking-tight sm:text-[32px]">
              One engine, every screen
            </h2>
            <p className="mt-[12px] text-[15px] leading-relaxed text-[var(--text-secondary)]">
              The same backend serves every client in the monorepo. Start a task at your desk and
              approve the last tool call from the couch.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-[16px] sm:grid-cols-2 lg:grid-cols-4">
            {PLATFORMS.map(({ icon: Icon, title, body }) => (
              <article
                key={title}
                className="rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-card)] p-[22px] transition-colors hover:border-[var(--border-card)]"
              >
                <Icon className="mb-[14px] size-[22px] text-[var(--text-primary)]" strokeWidth={1.5} aria-hidden />
                <h3 className="text-[15px] font-semibold tracking-tight text-[var(--text-primary)]">{title}</h3>
                <p className="mt-[6px] text-[13px] leading-relaxed text-[var(--text-secondary)]">{body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* final CTA */}
      <section className="mx-auto max-w-[1100px] px-[24px] py-[88px] text-center">
        <CesiumMark className="mx-auto mb-[22px] h-[40px] w-auto text-[var(--text-primary)]" />
        <h2 className="text-balance text-[30px] font-semibold leading-tight tracking-tight sm:text-[36px]">
          Your code stays home. Your agents don&apos;t rest.
        </h2>
        <p className="mx-auto mt-[14px] max-w-[460px] text-[15px] leading-relaxed text-[var(--text-secondary)]">
          Two commands to run it locally, one deploy for the client. Everything else is already
          wired.
        </p>
        <div className="mt-[28px] flex flex-wrap items-center justify-center gap-[12px]">
          <Link
            href={WORKSPACE_ROUTE}
            className="inline-flex items-center gap-[8px] rounded-[var(--radius-tab)] bg-[var(--accent)] px-[20px] py-[10px] text-[14px] font-medium text-[var(--bg-main)] transition-colors hover:bg-[var(--accent-dark)]"
          >
            Open the workbench
            <ArrowRight className="size-[15px]" strokeWidth={2} aria-hidden />
          </Link>
        </div>
      </section>

      {/* footer */}
      <footer className="border-t border-[var(--border-subtle)]">
        <div className="mx-auto flex max-w-[1100px] flex-wrap items-center justify-between gap-[14px] px-[24px] py-[26px]">
          <div className="flex items-center gap-[8px] text-[var(--text-disabled)]">
            <CesiumMark className="h-[16px] w-auto" />
            <span className="text-[12px]">Cesium — local-first AI workbench</span>
          </div>
          <div className="flex items-center gap-[18px] text-[12px] text-[var(--text-disabled)]">
            <Link href="/docs" className="transition-colors hover:text-[var(--text-primary)]">
              Docs
            </Link>
            <Link href={WORKSPACE_ROUTE} className="transition-colors hover:text-[var(--text-primary)]">
              Workbench
            </Link>
            <span className="font-mono">AGPL-3.0</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

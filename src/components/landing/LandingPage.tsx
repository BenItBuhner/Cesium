import Link from "next/link";
import type { CSSProperties } from "react";
import {
  ArrowRight,
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
import {
  LandingClosingActions,
  LandingFooterActions,
  LandingHeaderActions,
  LandingHeroActions,
} from "@/components/landing/LandingAuthActions";

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
          <span className="size-[10px] rounded-full bg-[var(--goal-accent)] opacity-80" />
          <span className="size-[10px] rounded-full bg-[var(--plan-accent)] opacity-80" />
          <span className="size-[10px] rounded-full bg-[var(--ask-accent)] opacity-80" />
          <span className="ml-[10px] font-mono text-[11px] text-[var(--text-disabled)]">
            cesium — /agent · kimi-k3
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
        A live session — an agent tracing WebSocket reconnect logic in this repo.
      </figcaption>
    </figure>
  );
}

/* ------------------------------------------------------------------------ */
/* Content data                                                             */
/* ------------------------------------------------------------------------ */

const AGENT_MARQUEE = [
  { name: "Cesium", file: "Cesium-Light.svg" },
  { name: "Cursor", file: "Cursor-Light.svg" },
  { name: "Codex", file: "Codex-Light.svg" },
  { name: "Claude Code", file: "Claude-Code-Light.svg" },
  { name: "OpenCode", file: "OpenCode-Light.svg" },
  { name: "Devin", file: "Devin-Light.svg" },
  { name: "Grok Build", file: "Grok-Light.svg" },
  { name: "Pi Agent", file: "Pi-Light.svg" },
  { name: "Antigravity", file: "Antigravity-Light.svg" },
] as const;

const FEATURES = [
  {
    icon: MessagesSquare,
    title: "Agent conversations",
    body: "Streaming chats with tool approvals and history that survives restarts.",
    accent: "var(--orchestration-accent)",
    accentBg: "var(--orchestration-accent-bg)",
  },
  {
    icon: SquareCode,
    title: "A real IDE, in the browser",
    body: "Editor, file tree, and tabs on the folders on your disk — not a sandbox.",
    accent: "var(--workflow-accent)",
    accentBg: "var(--workflow-accent-bg)",
  },
  {
    icon: TerminalSquare,
    title: "Integrated terminals",
    body: "Watch what your agents run, scroll back through it, and take over whenever you want.",
    accent: "var(--goal-accent)",
    accentBg: "var(--goal-accent-bg)",
  },
  {
    icon: FolderOpen,
    title: "Workspaces on your terms",
    body: "Switch between real directories. Access stays scoped to folders you chose.",
    accent: "var(--plan-accent)",
    accentBg: "var(--plan-accent-bg)",
  },
  {
    icon: Mic,
    title: "Voice input",
    body: "Dictate prompts. Configure transcription once and talk to your codebase.",
    accent: "var(--ask-accent)",
    accentBg: "var(--ask-accent-bg)",
  },
  {
    icon: Database,
    title: "Storage that scales with you",
    body: "Plain files by default — no services to run. Switch to a database when you need to.",
    accent: "var(--debug-accent)",
    accentBg: "var(--debug-accent-bg)",
  },
] as const;

const PLATFORMS = [
  {
    icon: Globe,
    title: "Web",
    body: "Any modern browser, installable as an app.",
  },
  {
    icon: Monitor,
    title: "Desktop",
    body: "A native windowed workbench on the same engine.",
  },
  {
    icon: Smartphone,
    title: "Mobile",
    body: "Your agents, pocket-sized.",
  },
  {
    icon: Tablet,
    title: "Tablet",
    body: "Touch-tuned layout for iPad.",
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
            <p className="font-mono text-[11px] text-[var(--text-disabled)]">Open from anywhere</p>
          </div>
        </div>
        <ul className="space-y-[8px] text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
          <li>A window onto your machine — nothing sensitive lives here.</li>
          <li>Installable as an app; one setting points it at your engine.</li>
          <li>Open it from a laptop, a phone, or a tablet.</li>
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
            <p className="font-mono text-[11px] text-[var(--text-disabled)]">Runs with your code</p>
          </div>
        </div>
        <ul className="space-y-[8px] text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
          <li>Files, terminals, and agents never leave your machine.</li>
          <li>Auth and rate limits when you open it beyond this computer.</li>
          <li>Local files by default; a database when you scale.</li>
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
              href="/download"
              className="rounded-[var(--radius-tab)] px-[12px] py-[6px] text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
            >
              Download
            </Link>
            <Link
              href="/docs"
              className="rounded-[var(--radius-tab)] px-[12px] py-[6px] text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
            >
              Docs
            </Link>
            <LandingHeaderActions />
          </nav>
        </div>
      </header>

      {/* hero */}
      <section className="relative">
        <div className="landing-grid-bg pointer-events-none absolute inset-0" aria-hidden />
        <div className="relative mx-auto max-w-[1100px] px-[24px] pb-[64px] pt-[64px] sm:pt-[88px]">
          <div className="grid grid-cols-1 items-center gap-[48px] lg:grid-cols-[minmax(0,1fr)_auto]">
            <div>
              <h1 className="text-balance text-[42px] font-semibold leading-[1.05] tracking-tight sm:text-[58px]">
                Every agent.
                <br />
                Your machine.
                <br />
                One workbench.
              </h1>
              <p className="mt-[22px] max-w-[480px] text-pretty text-[16px] leading-relaxed text-[var(--text-secondary)]">
                Chat with any coding agent, edit real files, and run real terminals — on your
                machine, from anywhere.
              </p>
              <div className="mt-[32px] flex flex-wrap items-center gap-[12px]">
                <LandingHeroActions />
              </div>
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
          Works with the agents you already use
        </p>
        <div className="landing-marquee overflow-hidden">
          <div className="landing-marquee-track flex w-max items-center">
            {marqueeItems.map(({ name, file }, i) => (
              <span
                key={`${name}-${i}`}
                className="mx-[26px] inline-flex items-center gap-[10px] text-[var(--text-secondary)]"
              >
                <AgentMask file={file} className="size-[20px]" />
                <span className="whitespace-nowrap text-[14px] font-medium">{name}</span>
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
            oscillations of a caesium-133 atom define one second. Named for the element that keeps
            time honest — every agent event is streamed live, so nothing goes unaccounted for.
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
            Everything an agent needs to work — and everything you need to watch it — in one window.
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
            <SectionLabel index="02">Architecture</SectionLabel>
            <h2 className="text-[28px] font-semibold leading-tight tracking-tight sm:text-[32px]">
              Cloud reach. Local roots.
            </h2>
            <p className="mt-[12px] text-[15px] leading-relaxed text-[var(--text-secondary)]">
              The client is a window you can open from anywhere. The engine stays on hardware you
              control. Your source never has to leave home.
            </p>
          </div>
          <ArchitectureDiagram />
        </div>
      </section>

      {/* interoperability */}
      <section className="mx-auto max-w-[1100px] px-[24px] py-[72px]">
        <div className="grid grid-cols-1 items-center gap-[40px] lg:grid-cols-2">
          <div>
            <SectionLabel index="03">Agents</SectionLabel>
            <h2 className="text-[28px] font-semibold leading-tight tracking-tight sm:text-[32px]">
              One conversation, many minds
            </h2>
            <p className="mt-[12px] max-w-[480px] text-[15px] leading-relaxed text-[var(--text-secondary)]">
              Switch agents mid-thread with context intact. Pick models from one composer. You
              approve every tool call, whichever agent is driving.
            </p>
            <ul className="mt-[20px] space-y-[10px] text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
              <li className="flex items-start gap-[10px]">
                <ShieldCheck className="mt-[2px] size-[15px] shrink-0 text-[var(--ask-accent)]" strokeWidth={1.75} aria-hidden />
                You approve each tool call.
              </li>
              <li className="flex items-start gap-[10px]">
                <ArrowRight className="mt-[2px] size-[15px] shrink-0 text-[var(--orchestration-accent)]" strokeWidth={1.75} aria-hidden />
                Recent messages go with the handoff.
              </li>
              <li className="flex items-start gap-[10px]">
                <Cpu className="mt-[2px] size-[15px] shrink-0 text-[var(--workflow-accent)]" strokeWidth={1.75} aria-hidden />
                Bring your own keys. You own the accounts.
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
                        handoff
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
              Start a task at your desk. Approve the last tool call from the couch.
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
        <p className="mx-auto mt-[14px] max-w-[420px] text-[15px] leading-relaxed text-[var(--text-secondary)]">
          Sign up to sync, or keep going locally. Your code stays on your machine either way.
        </p>
        <div className="mt-[28px] flex flex-wrap items-center justify-center gap-[12px]">
          <LandingClosingActions />
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
            <Link href="/download" className="transition-colors hover:text-[var(--text-primary)]">
              Download
            </Link>
            <Link href="/docs" className="transition-colors hover:text-[var(--text-primary)]">
              Docs
            </Link>
            <LandingFooterActions />
            <span className="font-mono">AGPL-3.0</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

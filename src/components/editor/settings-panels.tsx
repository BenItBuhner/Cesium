"use client";

import { useState, type ComponentType, type ReactNode } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Info,
  Lock,
  RefreshCw,
  X,
} from "lucide-react";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";

export const rowButtonClass =
  "inline-flex shrink-0 items-center gap-[6px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-transparent px-[12px] py-[5px] font-sans text-[12px] font-normal text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]";

const selectClass =
  "inline-flex min-w-[160px] max-w-[240px] shrink-0 items-center justify-between gap-[8px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] py-[6px] font-sans text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]";

const tagClass =
  "inline-flex items-center gap-[6px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[8px] py-[3px] font-mono text-[11px] text-[var(--text-primary)]";

export function SettingsSection({
  title,
  children,
  action,
}: {
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const showHeader = Boolean((title && title.length > 0) || action);
  return (
    <section className="mb-[20px]">
      {showHeader ? (
        <div className="mb-[10px] flex items-center justify-between gap-[12px] px-[2px]">
          {title ? (
            <h2 className="font-sans text-[15px] font-semibold text-[var(--text-primary)]">
              {title}
            </h2>
          ) : (
            <span />
          )}
          {action}
        </div>
      ) : null}
      <div className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)]">
        {children}
      </div>
    </section>
  );
}

export function SettingsRow({
  title,
  description,
  trailing,
  border = true,
  titleExtra,
}: {
  title: string;
  description?: string;
  trailing: ReactNode;
  border?: boolean;
  titleExtra?: ReactNode;
}) {
  return (
    <div
      className={`flex min-h-[56px] items-center justify-between gap-[16px] px-[16px] py-[12px] ${
        border ? "border-b border-[var(--border-subtle)] last:border-b-0" : ""
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-[8px] font-sans text-[13px] font-medium text-[var(--text-primary)]">
          {title}
          {titleExtra}
        </p>
        {description ? (
          <p className="mt-[4px] font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
            {description}
          </p>
        ) : null}
      </div>
      <div className="shrink-0">{trailing}</div>
    </div>
  );
}

function SubsectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="border-b border-[var(--border-subtle)] bg-[var(--bg-main)] px-[16px] py-[8px]">
      <p className="font-sans text-[11px] font-medium uppercase tracking-wide text-[var(--text-disabled)]">
        {children}
      </p>
    </div>
  );
}

function SelectMock({ label }: { label: string }) {
  return (
    <button type="button" className={selectClass}>
      <span className="truncate">{label}</span>
      <ChevronDown className="size-[14px] shrink-0 text-[var(--text-disabled)]" strokeWidth={1.5} />
    </button>
  );
}

function TagList({ tags, onRemove }: { tags: string[]; onRemove?: (t: string) => void }) {
  return (
    <div className="flex max-w-[min(100%,420px)] flex-wrap justify-end gap-[6px]">
      {tags.map((t) => (
        <span key={t} className={tagClass}>
          <span className="max-w-[200px] truncate">{t}</span>
          {onRemove ? (
            <button
              type="button"
              className="rounded p-[1px] text-[var(--text-disabled)] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
              aria-label={`Remove ${t}`}
              onClick={() => onRemove(t)}
            >
              <X className="size-[12px]" strokeWidth={2} />
            </button>
          ) : null}
        </span>
      ))}
    </div>
  );
}

function EmptyWell({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-[120px] flex-col items-center justify-center gap-[12px] rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-main)] px-[16px] py-[24px] text-center">
      <p className="max-w-[360px] font-sans text-[13px] leading-relaxed text-[var(--text-secondary)]">
        {children}
      </p>
      {action}
    </div>
  );
}

function PageIntro({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <>
      <h1 className="mb-[6px] font-sans text-[22px] font-semibold tracking-tight text-[var(--text-primary)]">
        {title}
      </h1>
      {subtitle ? (
        <p className="mb-[22px] max-w-[560px] font-sans text-[13px] leading-relaxed text-[var(--text-secondary)]">
          {subtitle}
        </p>
      ) : null}
    </>
  );
}

/* ——— Panels ——— */

export function GeneralSettingsPanel() {
  const [sysNotify, setSysNotify] = useState(true);
  const [warnNotify, setWarnNotify] = useState(false);
  const [trayIcon, setTrayIcon] = useState(true);
  const [completionSound, setCompletionSound] = useState(true);

  return (
    <>
      <PageIntro
        title="General"
        subtitle="Account, editor links, notifications, and privacy (demo UI)."
      />
      <SettingsSection title="Manage Account">
        <SettingsRow
          title="Manage Account"
          description="Manage your account and billing."
          trailing={
            <button type="button" className={rowButtonClass}>
              Open
              <ExternalLink className="size-[14px]" strokeWidth={1.5} aria-hidden />
            </button>
          }
        />
      </SettingsSection>
      <SettingsSection title="Preferences">
        <SettingsRow
          title="Editor Settings"
          description="Configure font, formatting, minimap and more"
          trailing={
            <button type="button" className={rowButtonClass}>
              Open
              <ExternalLink className="size-[14px]" strokeWidth={1.5} aria-hidden />
            </button>
          }
        />
        <SettingsRow
          title="Keyboard Shortcuts"
          description="Customize keyboard shortcuts for commands and workflows."
          trailing={
            <button type="button" className={rowButtonClass}>
              Open
              <ExternalLink className="size-[14px]" strokeWidth={1.5} aria-hidden />
            </button>
          }
        />
        <SettingsRow
          title="Import Settings from VS Code"
          description="Bring your editor preferences from VS Code into this workspace."
          trailing={<button type="button" className={rowButtonClass}>Import</button>}
          border={false}
        />
      </SettingsSection>
      <SettingsSection title="Notifications">
        <SettingsRow
          title="System notifications"
          description="Show notifications for important events and completions."
          trailing={<ToggleSwitch checked={sysNotify} onChange={setSysNotify} size="md" />}
        />
        <SettingsRow
          title="Warning Notifications"
          description="Surface warnings and non-fatal issues as notifications."
          trailing={<ToggleSwitch checked={warnNotify} onChange={setWarnNotify} size="md" />}
        />
        <SettingsRow
          title="System Tray Icon"
          description="Keep an icon in the system tray while the app runs."
          trailing={<ToggleSwitch checked={trayIcon} onChange={setTrayIcon} size="md" />}
        />
        <SettingsRow
          title="Completion Sound"
          description="Play a short sound when a generation completes."
          trailing={
            <ToggleSwitch checked={completionSound} onChange={setCompletionSound} size="md" />
          }
          border={false}
        />
      </SettingsSection>
      <SettingsSection title="Privacy">
        <SettingsRow
          title="Privacy Mode"
          description="When enabled, your code is not used to train models. Some cloud features may be limited in this demo."
          trailing={
            <button type="button" className={rowButtonClass}>
              <Lock className="size-[14px]" strokeWidth={1.5} aria-hidden />
              Privacy Mode
            </button>
          }
          border={false}
        />
      </SettingsSection>
      <div className="mt-[8px] px-[2px]">
        <button
          type="button"
          className="font-sans text-[13px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
        >
          Log Out
        </button>
      </div>
    </>
  );
}

const CMD_TAGS = [
  "pip install *",
  "npm install *",
  "uv install *",
  "python *",
  "cd *",
  "ls *",
  "grep *",
  "Select-Object *",
];

const MODE_TAGS = ["agent-plan"];

export function AgentsSettingsPanel() {
  const [a, setA] = useState({
    submitCtrlEnter: false,
    autocomplete: false,
    webSearch: true,
    autoWeb: true,
    webFetch: true,
    hierIgnore: false,
    symlinkIgnore: false,
    legacyTerm: false,
    autoParse: false,
    themedDiff: true,
    collapseAuto: true,
    commitAttr: true,
    prAttr: true,
    fileDel: true,
    extFile: true,
    browserProt: false,
    mcpProt: false,
  });
  const [cmdTags, setCmdTags] = useState(CMD_TAGS);
  const [modeTags, setModeTags] = useState(MODE_TAGS);

  const rm = (arr: string[], t: string) => arr.filter((x) => x !== t);

  return (
    <>
      <PageIntro title="Agents" />
      <SettingsSection>
        <SettingsRow
          title="Submit with Ctrl + Enter"
          description="When enabled, Ctrl + Enter submits chat and Enter inserts a newline."
          trailing={
            <ToggleSwitch
              checked={a.submitCtrlEnter}
              onChange={(v) => setA((s) => ({ ...s, submitCtrlEnter: v }))}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          title="Queue Messages"
          description="Adjust the default behavior of sending a message while Agent is running."
          trailing={<SelectMock label="Send after current message" />}
        />
        <SettingsRow
          title="Usage Summary"
          description="When to show the usage summary at the bottom of the chat pane."
          trailing={<SelectMock label="Auto" />}
        />
        <SettingsRow
          title="Agent Autocomplete"
          description="Contextual suggestions while prompting Agent."
          trailing={
            <ToggleSwitch
              checked={a.autocomplete}
              onChange={(v) => setA((s) => ({ ...s, autocomplete: v }))}
              size="md"
              variant="green"
            />
          }
          border={false}
        />
      </SettingsSection>
      <SettingsSection>
        <SubsectionLabel>Context</SubsectionLabel>
        <SettingsRow
          title="Web Search Tool"
          description="Allow Agent to search the web for relevant information."
          trailing={
            <ToggleSwitch
              checked={a.webSearch}
              onChange={(v) => setA((s) => ({ ...s, webSearch: v }))}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          title="Auto-Accept Web Search"
          description="Skip approval dialog. Agent may run web searches automatically."
          trailing={
            <ToggleSwitch
              checked={a.autoWeb}
              onChange={(v) => setA((s) => ({ ...s, autoWeb: v }))}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          title="Web fetch tool"
          description="Allow Agent to fetch content from URLs."
          trailing={
            <ToggleSwitch
              checked={a.webFetch}
              onChange={(v) => setA((s) => ({ ...s, webFetch: v }))}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          title="Hierarchical Cursor Ignore"
          description="Apply .cursorignore files in all subdirectories. Changing this setting will require a restart."
          trailing={
            <ToggleSwitch
              checked={a.hierIgnore}
              onChange={(v) => setA((s) => ({ ...s, hierIgnore: v }))}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          title="Ignore Symlinks in Cursor Ignore Search"
          description="Use with caution. Skip symlinks during .cursorignore file discovery."
          titleExtra={
            <span
              className="rounded-[2px] bg-[#f59e0b]/20 px-[4px] font-sans text-[9px] font-semibold uppercase text-[#b45309]"
              title="Warning"
            >
              !
            </span>
          }
          trailing={
            <ToggleSwitch
              checked={a.symlinkIgnore}
              onChange={(v) => setA((s) => ({ ...s, symlinkIgnore: v }))}
              size="md"
              variant="green"
            />
          }
          border={false}
        />
      </SettingsSection>
      <SettingsSection>
        <SubsectionLabel>Auto-Run</SubsectionLabel>
        <SettingsRow
          title="Auto-Run Mode"
          description="Choose how Agent runs tools like command execution, MCP, and file writes."
          trailing={<SelectMock label="Auto-Run in Sandbox" />}
        />
        <SettingsRow
          title="Auto-Run Network Access"
          description="Control which network requests are allowed when commands run in the sandbox."
          trailing={<SelectMock label="sandbox.json + Defaults" />}
        />
        <SettingsRow
          title="Auto-Approved Mode Transitions"
          description="Mode transitions that will be automatically approved without prompting."
          trailing={<TagList tags={modeTags} onRemove={(t) => setModeTags((x) => rm(x, t))} />}
        />
        <SettingsRow
          title="Command Allowlist"
          description="Commands Agent may run without confirmation when auto-run is enabled."
          trailing={<TagList tags={cmdTags} onRemove={(t) => setCmdTags((x) => rm(x, t))} />}
          border={false}
        />
      </SettingsSection>
      <SettingsSection title="Protection">
        <SettingsRow
          title="Browser Protection"
          description="Prevent Agent from automatically running Browser tools."
          trailing={
            <ToggleSwitch
              checked={a.browserProt}
              onChange={(v) => setA((s) => ({ ...s, browserProt: v }))}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          title="MCP Tools Protection"
          description="Prevent Agent from automatically running MCP tools."
          trailing={
            <ToggleSwitch
              checked={a.mcpProt}
              onChange={(v) => setA((s) => ({ ...s, mcpProt: v }))}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          title="File Deletion Protection"
          description="Prevent Agent from deleting files automatically."
          trailing={
            <ToggleSwitch
              checked={a.fileDel}
              onChange={(v) => setA((s) => ({ ...s, fileDel: v }))}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          title="External File Protection"
          description="Prevent Agent from creating or modifying files outside of the workspace automatically."
          trailing={
            <ToggleSwitch
              checked={a.extFile}
              onChange={(v) => setA((s) => ({ ...s, extFile: v }))}
              size="md"
              variant="green"
            />
          }
          border={false}
        />
      </SettingsSection>
      <SettingsSection title="">
        <SubsectionLabel>Inline editing & terminal</SubsectionLabel>
        <SettingsRow
          title="Legacy Terminal Tool"
          description="Use the legacy terminal tool in agent mode, for use on systems with unsupported shell configurations."
          trailing={
            <ToggleSwitch
              checked={a.legacyTerm}
              onChange={(v) => setA((s) => ({ ...s, legacyTerm: v }))}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          title="Auto-Parse Links"
          description="Automatically parse links when pasted into Quick Edit (Ctrl+K) input."
          trailing={
            <ToggleSwitch
              checked={a.autoParse}
              onChange={(v) => setA((s) => ({ ...s, autoParse: v }))}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          title="Themed Diff Backgrounds"
          description="Use themed background colors for inline code diffs."
          trailing={
            <ToggleSwitch
              checked={a.themedDiff}
              onChange={(v) => setA((s) => ({ ...s, themedDiff: v }))}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          title="Collapse Auto-Run Commands"
          description="Collapse auto-run command output by default in Terminal command previews."
          trailing={
            <ToggleSwitch
              checked={a.collapseAuto}
              onChange={(v) => setA((s) => ({ ...s, collapseAuto: v }))}
              size="md"
              variant="green"
            />
          }
          border={false}
        />
      </SettingsSection>
      <SettingsSection title="Voice mode">
        <SettingsRow
          title="Submit Keywords"
          description="Custom keywords that trigger auto-submit in voice mode. Only single words (no spaces) are allowed."
          trailing={<TagList tags={["submit"]} />}
          border={false}
        />
      </SettingsSection>
      <SettingsSection title="Attribution">
        <SettingsRow
          title="Commit Attribution"
          description="Mark Agent commits as &apos;Made with Cursor&apos;."
          trailing={
            <ToggleSwitch
              checked={a.commitAttr}
              onChange={(v) => setA((s) => ({ ...s, commitAttr: v }))}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          title="PR Attribution"
          description="Mark pull requests as made with Cursor."
          trailing={
            <ToggleSwitch
              checked={a.prAttr}
              onChange={(v) => setA((s) => ({ ...s, prAttr: v }))}
              size="md"
              variant="green"
            />
          }
          border={false}
        />
      </SettingsSection>
      <SettingsSection title="Git">
        <SettingsRow
          title="Branch Prefix"
          description="Prefix for new branches created by Agent (e.g. cursor/, username/)."
          trailing={
            <input
              type="text"
              placeholder="cursor/"
              defaultValue="cursor/"
              className="w-[min(100%,200px)] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] py-[6px] font-sans text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
            />
          }
          border={false}
        />
      </SettingsSection>
    </>
  );
}

const MODEL_ROWS = [
  { id: "c2", name: "Composer 2", on: true, premium: false },
  { id: "g4", name: "GPT-4o", on: true, premium: false },
  { id: "op", name: "Opus 4.8", on: true, premium: false },
  { id: "gm", name: "GPT-4o Mini", on: true, premium: false },
  { id: "c1", name: "Composer 1", on: false, premium: true },
  { id: "cx", name: "Codex 3.0", on: false, premium: true },
];

export function ModelsSettingsPanel() {
  const [models, setModels] = useState(MODEL_ROWS);
  const [apiOpen, setApiOpen] = useState(false);

  return (
    <>
      <PageIntro title="Models" />
      <div className="mb-[16px] flex items-center gap-[8px]">
        <div className="relative min-w-0 flex-1">
          <input
            type="search"
            placeholder="Add or search model"
            className="box-border h-[36px] w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] pl-[10px] pr-[10px] font-sans text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
          />
        </div>
        <button
          type="button"
          className="flex size-[36px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] text-[var(--text-secondary)] hover:bg-[var(--accent-bg)]"
          aria-label="Refresh models"
        >
          <RefreshCw className="size-[16px]" strokeWidth={1.5} />
        </button>
      </div>
      <SettingsSection>
        {models
          .filter((m) => !m.premium)
          .map((m) => (
            <SettingsRow
              key={m.id}
              title={m.name}
              trailing={
                <div className="flex items-center gap-[8px]">
                  <button
                    type="button"
                    className="text-[var(--text-disabled)] hover:text-[var(--text-primary)]"
                    aria-label={`About ${m.name}`}
                  >
                    <Info className="size-[14px]" strokeWidth={1.5} />
                  </button>
                  <ToggleSwitch
                    checked={m.on}
                    onChange={(v) =>
                      setModels((rows) =>
                        rows.map((r) => (r.id === m.id ? { ...r, on: v } : r))
                      )
                    }
                    size="md"
                    variant="green"
                  />
                </div>
              }
            />
          ))}
        <SubsectionLabel>Premium</SubsectionLabel>
        {models
          .filter((m) => m.premium)
          .map((m) => (
            <SettingsRow
              key={m.id}
              title={m.name}
              trailing={
                <div className="flex items-center gap-[8px]">
                  <Info className="size-[14px] text-[var(--text-disabled)]" strokeWidth={1.5} />
                  <ToggleSwitch
                    checked={m.on}
                    onChange={(v) =>
                      setModels((rows) =>
                        rows.map((r) => (r.id === m.id ? { ...r, on: v } : r))
                      )
                    }
                    size="md"
                    variant="green"
                  />
                </div>
              }
              border={m.id !== "cx"}
            />
          ))}
        <div className="px-[16px] py-[12px]">
          <button
            type="button"
            className="font-sans text-[13px] font-medium text-[#2563eb] hover:underline"
          >
            View All Models
          </button>
        </div>
        <button
          type="button"
          onClick={() => setApiOpen(!apiOpen)}
          className="flex w-full items-center gap-[6px] border-t border-[var(--border-subtle)] px-[16px] py-[10px] font-sans text-[12px] text-[var(--text-secondary)] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
        >
          <ChevronRight
            className={`size-[14px] transition-transform ${apiOpen ? "rotate-90" : ""}`}
            strokeWidth={1.5}
          />
          API Keys
        </button>
        {apiOpen ? (
          <div className="border-t border-[var(--border-subtle)] px-[16px] py-[12px] font-sans text-[12px] text-[var(--text-secondary)]">
            API key management would open here.
          </div>
        ) : null}
      </SettingsSection>
    </>
  );
}

export function RulesSkillsSubagentsPanel() {
  const [thirdParty, setThirdParty] = useState(true);
  return (
    <>
      <PageIntro
        title="Rules, Skills, Subagents"
        subtitle="Provide domain-specific knowledge and workflows for the agent."
      />
      <SettingsSection>
        <SettingsRow
          title="Include third-party Plugins, Skills, and other configs"
          description="Automatically import agent configs from other tools."
          trailing={
            <ToggleSwitch checked={thirdParty} onChange={setThirdParty} size="md" variant="green" />
          }
          border={false}
        />
      </SettingsSection>
      <SettingsSection
        title="Rules"
        action={
          <button type="button" className="font-sans text-[12px] font-medium text-[#2563eb] hover:underline">
            + New
          </button>
        }
      >
        <div className="space-y-[8px] p-[12px]">
          {["Markdown Files", "Issue Resolution & Debugging", "Hospitality & Tech"].map((n) => (
            <div
              key={n}
              className="rounded-[var(--radius-tab)] border border-[var(--border-subtle)] bg-[var(--bg-main)] px-[12px] py-[10px] font-sans text-[12px] font-medium text-[var(--text-primary)]"
            >
              {n}
            </div>
          ))}
        </div>
      </SettingsSection>
      <SettingsSection
        title="Skills"
        action={
          <button type="button" className="font-sans text-[12px] font-medium text-[#2563eb] hover:underline">
            + New
          </button>
        }
      >
        <div className="divide-y divide-[var(--border-subtle)]">
          {[
            ["code-simplifier", "Simplifies and refines code for clarity."],
            ["frontend-ninja", "Distinctive production-grade UI work."],
            ["make-docs", "Documentation updates across the repo."],
            ["push", "Git push workflows."],
            ["openai-docs", "OpenAI product and API references."],
          ].map(([id, d]) => (
            <div key={id} className="px-[16px] py-[10px]">
              <p className="font-mono text-[12px] font-semibold text-[var(--text-primary)]">{id}</p>
              <p className="mt-[2px] font-sans text-[12px] text-[var(--text-secondary)]">{d}</p>
            </div>
          ))}
        </div>
        <div className="border-t border-[var(--border-subtle)] px-[16px] py-[10px]">
          <button type="button" className="font-sans text-[12px] text-[#2563eb] hover:underline">
            Show all (10 more)
          </button>
        </div>
      </SettingsSection>
      <SettingsSection
        title="Subagents"
        action={
          <button type="button" className="font-sans text-[12px] font-medium text-[#2563eb] hover:underline">
            + New
          </button>
        }
      >
        <div className="px-[16px] py-[12px]">
          <p className="font-mono text-[12px] font-semibold text-[var(--text-primary)]">docs-researcher</p>
          <p className="mt-[2px] font-sans text-[12px] text-[var(--text-secondary)]">
            Fetches library documentation on demand.
          </p>
        </div>
      </SettingsSection>
      <SettingsSection
        title="Community"
        action={
          <button type="button" className="font-sans text-[12px] font-medium text-[#2563eb] hover:underline">
            + New
          </button>
        }
      >
        <div className="divide-y divide-[var(--border-subtle)]">
          {["no-edit", "test-debug-and-iterate", "docs"].map((n) => (
            <div key={n} className="px-[16px] py-[10px] font-mono text-[12px] text-[var(--text-primary)]">
              {n}
            </div>
          ))}
        </div>
      </SettingsSection>
    </>
  );
}

const MCP_TAGS = [
  "figma:get_design_context",
  "figma:get_screenshot",
  "linear:get_issue",
  "linear:list_issues",
  "notion:notion-search",
  "slack:slack_read_channel",
];

const DOMAIN_TAGS = [
  "raw.githubusercontent.com",
  "github.com",
  "docs.polymarket.com",
  "api.github.com",
  "developer.notion.com",
  "www.todoist.com",
];

const PLUGIN_MCP = [
  { id: "c7", name: "context7", status: "2 tools enabled", on: true },
  { id: "fg", name: "Figma", status: "13 tools, 1 prompts, 25 resources enabled", on: true },
  { id: "ln", name: "Linear", status: "34 tools enabled", on: true },
  { id: "nt", name: "Notion", status: "needs authentication", on: false, connect: true },
  { id: "sl", name: "Slack", status: "13 tools, 1 resources enabled", on: true },
];

export function ToolsMcpSettingsPanel() {
  const [localhost, setLocalhost] = useState(true);
  const [mcpTags] = useState(MCP_TAGS);
  const [domainTags] = useState(DOMAIN_TAGS);
  const [pluginState, setPluginState] = useState(PLUGIN_MCP);

  return (
    <>
      <PageIntro title="Tools" subtitle="Browser automation, MCP servers, and allowlists." />
      <div className="mb-[16px] flex flex-wrap gap-[6px] border-b border-[var(--border-subtle)] pb-[10px]">
        {["Home", "opencursor", "Cloud"].map((t, i) => (
          <button
            key={t}
            type="button"
            className={`border-b-2 px-[10px] pb-[8px] font-sans text-[12px] ${
              i === 0
                ? "border-[#2563eb] font-medium text-[var(--text-primary)]"
                : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      <SettingsSection title="Browser">
        <SettingsRow
          title="Browser Automation"
          description="Connected to Browser Tab."
          trailing={<SelectMock label="Browser Tab" />}
        />
        <SettingsRow
          title="Show Localhost Links in Browser"
          description="Automatically open localhost links in the Browser Tab."
          trailing={
            <ToggleSwitch checked={localhost} onChange={setLocalhost} size="md" variant="green" />
          }
          border={false}
        />
      </SettingsSection>
      <SettingsSection title="User MCP Servers">
        <div className="p-[12px]">
          <p className="mb-[10px] font-sans text-[12px] text-[var(--text-secondary)]">
            Servers available in this workspace.
          </p>
          <EmptyWell action={<button type="button" className={rowButtonClass}>Add Custom MCP</button>}>
            No User MCP tools. Add a custom MCP tool in your user MCP config.
          </EmptyWell>
        </div>
      </SettingsSection>
      <SettingsSection
        title="Team MCP Servers"
        action={
          <button type="button" className="font-sans text-[12px] text-[#2563eb] hover:underline">
            Manage
          </button>
        }
      >
        <div className="p-[12px]">
          <p className="mb-[10px] font-sans text-[12px] text-[var(--text-secondary)]">
            Configured on the dashboard.
          </p>
          <EmptyWell
            action={
              <button type="button" className={rowButtonClass}>
                Configure Team MCP Servers
              </button>
            }
          >
            No Team MCP Servers. Configure MCP servers in the dashboard to make them available on desktop and in the cloud.
          </EmptyWell>
        </div>
      </SettingsSection>
      <SettingsSection title="Plugin MCP Servers">
        {pluginState.map((p, i) => (
          <div
            key={p.id}
            className={`flex min-h-[56px] items-center justify-between gap-[12px] px-[16px] py-[12px] ${
              i < pluginState.length - 1 ? "border-b border-[var(--border-subtle)]" : ""
            }`}
          >
            <div className="min-w-0">
              <p className="font-sans text-[13px] font-semibold text-[var(--text-primary)]">{p.name}</p>
              <p className="mt-[2px] font-sans text-[12px] text-[var(--text-secondary)]">{p.status}</p>
            </div>
            {p.connect ? (
              <button
                type="button"
                className="rounded-[var(--radius-tab)] bg-[#2563eb] px-[12px] py-[5px] font-sans text-[12px] font-medium text-white hover:bg-[#1d4ed8]"
              >
                Connect
              </button>
            ) : (
              <ToggleSwitch
                checked={p.on}
                onChange={(v) =>
                  setPluginState((rows) =>
                    rows.map((r) => (r.id === p.id ? { ...r, on: v } : r))
                  )
                }
                size="md"
                variant="green"
              />
            )}
          </div>
        ))}
      </SettingsSection>
      <SettingsSection title="Allowlists">
        <SettingsRow
          title="MCP Allowlist"
          description="MCP tools that can run automatically. Format: &apos;server:tool&apos;, &apos;server:*&apos;, &apos;tool&apos;, or &apos;*&apos;."
          trailing={<TagList tags={mcpTags} />}
        />
        <SettingsRow
          title="Fetch Domain Allowlist"
          description="Domains that Agent can fetch from automatically. Use &apos;*&apos; for all domains."
          trailing={<TagList tags={domainTags} />}
          border={false}
        />
      </SettingsSection>
    </>
  );
}

export function BetaSettingsPanel() {
  const [rpc, setRpc] = useState(false);
  return (
    <>
      <PageIntro title="Beta" />
      <SettingsSection>
        <SettingsRow
          title="Update Access"
          description="By default, get notifications for stable updates. In Early Access, pre-release builds may be unsuitable for production work."
          trailing={<SelectMock label="Nightly" />}
        />
        <div className="border-b border-[var(--border-subtle)] px-[16px] pb-[14px]">
          <div className="flex gap-[10px] rounded-[var(--radius-tab)] border border-[#f59e0b]/35 bg-[#fff7ed] px-[12px] py-[10px] dark:border-[#f59e0b]/25 dark:bg-[#422006]/40">
            <AlertTriangle className="mt-[2px] size-[16px] shrink-0 text-[#d97706]" strokeWidth={2} />
            <p className="font-sans text-[12px] leading-snug text-[#9a3412] dark:text-[#fdba74]">
              <strong className="font-semibold">Warning:</strong> Nightly Updates Apply Automatically. Nightly builds
              will silently download and install updates without prompting whenever the app is closed.
            </p>
          </div>
        </div>
        <SettingsRow
          title="Extension RPC Tracer"
          description="Log extension host RPC messages to JSON files viewable in Perfetto for performance analysis. Requires a restart."
          trailing={<ToggleSwitch checked={rpc} onChange={setRpc} size="md" variant="green" />}
          border={false}
        />
      </SettingsSection>
      <h2 className="mt-[24px] font-sans text-[13px] font-semibold text-[var(--text-secondary)]">
        Development
      </h2>
    </>
  );
}

export const SETTINGS_PANELS: Record<string, ComponentType> = {
  general: GeneralSettingsPanel,
  agents: AgentsSettingsPanel,
  models: ModelsSettingsPanel,
  rulesSkills: RulesSkillsSubagentsPanel,
  tools: ToolsMcpSettingsPanel,
  beta: BetaSettingsPanel,
};

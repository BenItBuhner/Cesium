"use client";

import { useMemo, useState, type ComponentType, type ReactNode } from "react";
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
import { HardwareAwareTextInput } from "@/components/input/HardwareAwareTextField";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useUserPreferences } from "@/components/preferences/UserPreferencesProvider";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { availableModels, currentModel } from "@/lib/mock-data";

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
  const { settings, updateSettings } = useGlobalSettings();
  const general = settings.general;

  const patchGeneral = (patch: Partial<typeof general>) => {
    updateSettings((current) => ({
      ...current,
      general: {
        ...current.general,
        ...patch,
      },
    }));
  };

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
          trailing={
            <ToggleSwitch
              checked={general.sysNotify}
              onChange={(value) => patchGeneral({ sysNotify: value })}
              size="md"
            />
          }
        />
        <SettingsRow
          title="Warning Notifications"
          description="Surface warnings and non-fatal issues as notifications."
          trailing={
            <ToggleSwitch
              checked={general.warnNotify}
              onChange={(value) => patchGeneral({ warnNotify: value })}
              size="md"
            />
          }
        />
        <SettingsRow
          title="System Tray Icon"
          description="Keep an icon in the system tray while the app runs."
          trailing={
            <ToggleSwitch
              checked={general.trayIcon}
              onChange={(value) => patchGeneral({ trayIcon: value })}
              size="md"
            />
          }
        />
        <SettingsRow
          title="Completion Sound"
          description="Play a short sound when a generation completes."
          trailing={
            <ToggleSwitch
              checked={general.completionSound}
              onChange={(value) => patchGeneral({ completionSound: value })}
              size="md"
            />
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

export function AgentsSettingsPanel() {
  const { settings, updateSettings } = useGlobalSettings();
  const agents = settings.agents;

  const patchAgents = (patch: Partial<typeof agents>) => {
    updateSettings((current) => ({
      ...current,
      agents: {
        ...current.agents,
        ...patch,
      },
    }));
  };

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
              checked={agents.submitCtrlEnter}
              onChange={(v) => patchAgents({ submitCtrlEnter: v })}
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
              checked={agents.autocomplete}
              onChange={(v) => patchAgents({ autocomplete: v })}
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
              checked={agents.webSearch}
              onChange={(v) => patchAgents({ webSearch: v })}
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
              checked={agents.autoWeb}
              onChange={(v) => patchAgents({ autoWeb: v })}
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
              checked={agents.webFetch}
              onChange={(v) => patchAgents({ webFetch: v })}
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
              checked={agents.hierIgnore}
              onChange={(v) => patchAgents({ hierIgnore: v })}
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
              checked={agents.symlinkIgnore}
              onChange={(v) => patchAgents({ symlinkIgnore: v })}
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
          trailing={
            <TagList
              tags={agents.modeTags}
              onRemove={(t) => patchAgents({ modeTags: rm(agents.modeTags, t) })}
            />
          }
        />
        <SettingsRow
          title="Command Allowlist"
          description="Commands Agent may run without confirmation when auto-run is enabled."
          trailing={
            <TagList
              tags={agents.cmdTags}
              onRemove={(t) => patchAgents({ cmdTags: rm(agents.cmdTags, t) })}
            />
          }
          border={false}
        />
      </SettingsSection>
      <SettingsSection title="Protection">
        <SettingsRow
          title="Browser Protection"
          description="Prevent Agent from automatically running Browser tools."
          trailing={
            <ToggleSwitch
              checked={agents.browserProt}
              onChange={(v) => patchAgents({ browserProt: v })}
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
              checked={agents.mcpProt}
              onChange={(v) => patchAgents({ mcpProt: v })}
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
              checked={agents.fileDel}
              onChange={(v) => patchAgents({ fileDel: v })}
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
              checked={agents.extFile}
              onChange={(v) => patchAgents({ extFile: v })}
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
              checked={agents.legacyTerm}
              onChange={(v) => patchAgents({ legacyTerm: v })}
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
              checked={agents.autoParse}
              onChange={(v) => patchAgents({ autoParse: v })}
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
              checked={agents.themedDiff}
              onChange={(v) => patchAgents({ themedDiff: v })}
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
              checked={agents.collapseAuto}
              onChange={(v) => patchAgents({ collapseAuto: v })}
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
              checked={agents.commitAttr}
              onChange={(v) => patchAgents({ commitAttr: v })}
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
              checked={agents.prAttr}
              onChange={(v) => patchAgents({ prAttr: v })}
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
            <HardwareAwareTextInput
              type="text"
               value={agents.branchPrefix}
               onChange={(value) => patchAgents({ branchPrefix: value })}
              placeholder="cursor/"
              className="w-[min(100%,200px)] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] py-[6px] font-sans text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
              ariaLabel="Branch prefix"
            />
          }
          border={false}
        />
      </SettingsSection>
    </>
  );
}

function createModelsSettingsState(): { id: string; name: string; on: boolean }[] {
  return availableModels.map((m) => ({
    id: m.id,
    name: m.name,
    on: m.id === currentModel.id,
  }));
}

export function ModelsSettingsPanel() {
  const { settings, updateSettings } = useGlobalSettings();
  const [apiOpen, setApiOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const models = settings.models.models.length
    ? settings.models.models
    : createModelsSettingsState();

  const setModels = (
    updater: (current: { id: string; name: string; on: boolean }[]) => {
      id: string;
      name: string;
      on: boolean;
    }[]
  ) => {
    updateSettings((current) => ({
      ...current,
      models: {
        ...current.models,
        models: updater(current.models.models),
      },
    }));
  };

  const visibleModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    if (!q) return models;
    return models.filter((model) => model.name.toLowerCase().includes(q));
  }, [modelQuery, models]);

  return (
    <>
      <PageIntro title="Models" />
      <div className="mb-[16px] flex items-center gap-[8px]">
        <div className="relative min-w-0 flex-1">
          <HardwareAwareTextInput
            type="search"
            value={modelQuery}
            onChange={setModelQuery}
            placeholder="Add or search model"
            className="box-border h-[36px] w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] pl-[10px] pr-[10px] font-sans text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
            ariaLabel="Add or search model"
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
        {visibleModels.map((m, i) => (
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
            border={i < visibleModels.length - 1}
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
  const { settings, updateSettings } = useGlobalSettings();
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
            <ToggleSwitch
              checked={settings.rules.thirdParty}
              onChange={(value) =>
                updateSettings((current) => ({
                  ...current,
                  rules: {
                    ...current.rules,
                    thirdParty: value,
                  },
                }))
              }
              size="md"
              variant="green"
            />
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

export function ToolsMcpSettingsPanel() {
  const { settings, updateSettings } = useGlobalSettings();
  const tools = settings.tools;

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
            <ToggleSwitch
              checked={tools.localhost}
              onChange={(value) =>
                updateSettings((current) => ({
                  ...current,
                  tools: {
                    ...current.tools,
                    localhost: value,
                  },
                }))
              }
              size="md"
              variant="green"
            />
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
        {tools.pluginState.map((p, i) => (
          <div
            key={p.id}
            className={`flex min-h-[56px] items-center justify-between gap-[12px] px-[16px] py-[12px] ${
              i < tools.pluginState.length - 1 ? "border-b border-[var(--border-subtle)]" : ""
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
                  updateSettings((current) => ({
                    ...current,
                    tools: {
                      ...current.tools,
                      pluginState: current.tools.pluginState.map((row) =>
                        row.id === p.id ? { ...row, on: v } : row
                      ),
                    },
                  }))
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
          trailing={<TagList tags={tools.mcpTags} />}
        />
        <SettingsRow
          title="Fetch Domain Allowlist"
          description="Domains that Agent can fetch from automatically. Use &apos;*&apos; for all domains."
          trailing={<TagList tags={tools.domainTags} />}
          border={false}
        />
      </SettingsSection>
    </>
  );
}

export function BetaSettingsPanel() {
  const {
    experimentalIpadMode,
    experimentalIpadCustomButtons,
    setExperimentalIpadMode,
    setExperimentalIpadCustomButtons,
  } = useUserPreferences();

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
      </SettingsSection>
      <h2 className="mt-[24px] font-sans text-[13px] font-semibold text-[var(--text-secondary)]">
        iPad
      </h2>
      <SettingsSection>
        <SettingsRow
          title="Text Input Abstraction"
          description="Use hardware-keyboard-first input surfaces on iPad and avoid native text fields where possible. Experimental and intended for iPad web app sessions with a connected physical keyboard."
          trailing={
            <ToggleSwitch
              checked={experimentalIpadMode}
              onChange={setExperimentalIpadMode}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          title="Custom Menu Buttons"
          description="Show explicit three-dot menu buttons for iPad-specific workarounds, starting with files and folders in the explorer tree."
          trailing={
            <ToggleSwitch
              checked={experimentalIpadCustomButtons}
              onChange={setExperimentalIpadCustomButtons}
              size="md"
              variant="green"
            />
          }
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

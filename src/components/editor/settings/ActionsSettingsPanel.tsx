"use client";

import { useCallback, useMemo, useState } from "react";
import { Pencil, Plus, Trash2, Zap } from "lucide-react";
import {
  QUICK_ACTION_PRESETS,
  QUICK_ACTION_UI_COMMANDS,
  QUICK_ACTION_VISIBILITY_OPTIONS,
  isQuickActionPresetEnabled,
  normalizeComposerPillsVisibility,
  type QuickActionDefinition,
  type QuickActionKind,
  type QuickActionVisibility,
} from "@cesium/core";
import {
  PageIntro,
  SettingsBlock,
  SettingsCallout,
  SettingsEmptyState,
  SettingsRow,
  SettingsSection,
  settingsSelectTriggerClass,
} from "@/components/editor/settings-ui";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { withComposerPillsVisibility } from "@/lib/composer-pills";
import { parseShortcutBinding } from "@/lib/keyboard-shortcuts";
import {
  deleteCustomQuickActionFromServer,
  saveCustomQuickActionToServer,
  setQuickActionPresetStatesOnServer,
  useQuickActionsConfig,
} from "@/lib/quick-actions";
import { QUICK_ACTION_PILL_ICON_NAMES } from "@/components/chat/ComposerActionPills";

const inputClass =
  "box-border h-[30px] w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[9px] font-sans text-[12px] leading-none text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)] focus:border-[var(--accent)]";
const textareaClass =
  "box-border min-h-[64px] w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[9px] py-[7px] font-mono text-[12px] leading-[17px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)] focus:border-[var(--accent)]";
const fieldLabelClass =
  "mb-[4px] block font-sans text-[11px] font-medium text-[var(--text-secondary)]";

type EditorState = {
  /** Existing action id when editing; null for the create form. */
  editingId: string | null;
  label: string;
  icon: string;
  kind: QuickActionKind;
  command: string;
  prompt: string;
  uiCommand: string;
  visibility: QuickActionVisibility;
  confirm: boolean;
  showPill: boolean;
  keybinding: string;
  enabled: boolean;
};

function emptyEditorState(): EditorState {
  return {
    editingId: null,
    label: "",
    icon: "Zap",
    kind: "command",
    command: "",
    prompt: "",
    uiCommand: QUICK_ACTION_UI_COMMANDS[0].id,
    visibility: "always",
    confirm: false,
    showPill: true,
    keybinding: "",
    enabled: true,
  };
}

function editorStateFromAction(action: QuickActionDefinition): EditorState {
  return {
    editingId: action.id,
    label: action.label,
    icon: action.icon ?? "Zap",
    kind: action.kind,
    command: action.command ?? "",
    prompt: action.prompt ?? "",
    uiCommand: action.uiCommand ?? QUICK_ACTION_UI_COMMANDS[0].id,
    visibility: action.visibility,
    confirm: action.confirm,
    showPill: action.showPill,
    keybinding: action.keybinding ?? "",
    enabled: action.enabled,
  };
}

function slugifyActionId(label: string): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "action"}-${Math.random().toString(36).slice(2, 7)}`;
}

export function ActionsSettingsPanel() {
  const { workspaceSession, updateWorkspaceSession } = useWorkspace();
  const { config, loaded, error } = useQuickActionsConfig();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const pillDefaults = normalizeComposerPillsVisibility(
    workspaceSession.chat.composerPillsVisibility
  );

  const setPillDefault = useCallback(
    (key: keyof typeof pillDefaults, checked: boolean) => {
      updateWorkspaceSession((current) => ({
        ...current,
        chat: withComposerPillsVisibility(current.chat, null, {
          ...normalizeComposerPillsVisibility(current.chat.composerPillsVisibility),
          [key]: checked,
        }),
      }));
    },
    [updateWorkspaceSession]
  );

  const keybindingInvalid = useMemo(() => {
    const raw = editor?.keybinding.trim();
    if (!raw) {
      return false;
    }
    const parsed = parseShortcutBinding(raw);
    return parsed == null || parsed.length !== 1;
  }, [editor?.keybinding]);

  const editorPayloadInvalid =
    editor != null &&
    (!editor.label.trim() ||
      (editor.kind === "command" && !editor.command.trim()) ||
      (editor.kind === "prompt" && !editor.prompt.trim()));

  const handleSave = useCallback(async () => {
    if (!editor || editorPayloadInvalid || keybindingInvalid) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await saveCustomQuickActionToServer({
        id: editor.editingId ?? slugifyActionId(editor.label),
        label: editor.label.trim(),
        icon: editor.icon,
        kind: editor.kind,
        ...(editor.kind === "command" ? { command: editor.command.trim() } : {}),
        ...(editor.kind === "prompt" ? { prompt: editor.prompt.trim() } : {}),
        ...(editor.kind === "ui" ? { uiCommand: editor.uiCommand } : {}),
        visibility: editor.visibility,
        confirm: editor.confirm,
        showPill: editor.showPill,
        keybinding: editor.keybinding.trim() || null,
        enabled: editor.enabled,
      });
      setEditor(null);
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : "Failed to save action.");
    } finally {
      setSaving(false);
    }
  }, [editor, editorPayloadInvalid, keybindingInvalid]);

  const handleDelete = useCallback(async (actionId: string) => {
    try {
      await deleteCustomQuickActionFromServer(actionId);
    } catch {
      /* surfaced by refetch */
    }
  }, []);

  const handlePresetToggle = useCallback((presetId: string, checked: boolean) => {
    void setQuickActionPresetStatesOnServer({ [presetId]: checked });
  }, []);

  return (
    <>
      <PageIntro title="Actions" />

      <SettingsSection title="Composer pills">
        <SettingsRow
          searchId="actions-pill-diff"
          title="Diff line counts"
          description="Show +added / −removed line totals for uncommitted changes above the composer. Click the pill for the per-file breakdown."
          trailing={
            <ToggleSwitch
              checked={pillDefaults.diff}
              onChange={(checked) => setPillDefault("diff", checked)}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          searchId="actions-pill-conflicts"
          title="Merge conflicts"
          description="Surface unresolved merge conflicts, and a confirmation pill once every conflict is fixed."
          trailing={
            <ToggleSwitch
              checked={pillDefaults.conflicts}
              onChange={(checked) => setPillDefault("conflicts", checked)}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          searchId="actions-pill-sync"
          title="Ahead / behind upstream"
          description="Show unpushed and unpulled commit counts for the current branch."
          trailing={
            <ToggleSwitch
              checked={pillDefaults.sync}
              onChange={(checked) => setPillDefault("sync", checked)}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          searchId="actions-pill-work"
          title="Background work"
          description="Show a live pill while other agents, cloud tasks, or terminals are running in this workspace."
          trailing={
            <ToggleSwitch
              checked={pillDefaults.work}
              onChange={(checked) => setPillDefault("work", checked)}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          searchId="actions-pill-actions"
          title="Quick action buttons"
          description="Show enabled preset and custom actions as clickable pills. These defaults apply to new conversations; each conversation keeps its own overrides via right-click on the pill row."
          trailing={
            <ToggleSwitch
              checked={pillDefaults.actions}
              onChange={(checked) => setPillDefault("actions", checked)}
              size="md"
              variant="green"
            />
          }
          border={false}
        />
      </SettingsSection>

      <SettingsSection title="Preset actions">
        {QUICK_ACTION_PRESETS.map((preset, index) => (
          <SettingsRow
            key={preset.id}
            searchId={`actions-preset-${preset.id}`}
            title={preset.label}
            description={preset.description}
            titleExtra={
              preset.kind === "command" ? (
                <code className="max-w-[340px] truncate rounded-[5px] bg-[var(--bg-main)] px-[6px] py-[1px] font-mono text-[10.5px] text-[var(--text-secondary)]">
                  {preset.command}
                </code>
              ) : (
                <span className="rounded-[5px] bg-[var(--bg-main)] px-[6px] py-[1px] font-sans text-[10.5px] uppercase tracking-[0.05em] text-[var(--text-secondary)]">
                  {preset.kind === "prompt" ? "Agent prompt" : "UI"}
                </span>
              )
            }
            trailing={
              <ToggleSwitch
                checked={isQuickActionPresetEnabled(config, preset)}
                onChange={(checked) => handlePresetToggle(preset.id, checked)}
                size="md"
                variant="green"
              />
            }
            border={index < QUICK_ACTION_PRESETS.length - 1}
          />
        ))}
      </SettingsSection>

      <SettingsSection
        title="Custom actions"
        action={
          editor == null ? (
            <button
              type="button"
              onClick={() => setEditor(emptyEditorState())}
              className="flex items-center gap-[5px] rounded-[var(--radius-tab)] border border-[var(--border-card)] px-[9px] py-[4px] font-sans text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]"
            >
              <Plus className="size-[13px]" strokeWidth={2} aria-hidden />
              New action
            </button>
          ) : null
        }
      >
        {error ? (
          <SettingsBlock>
            <SettingsCallout tone="danger">{error}</SettingsCallout>
          </SettingsBlock>
        ) : null}
        {loaded && config.customActions.length === 0 && editor == null ? (
          <SettingsEmptyState>
            No custom actions yet. Create shortcuts that run shell commands, send agent
            prompts, or drive the UI — from the pill row above the composer, a keybinding,
            or the SDK (`client.workspace(id).actions.run(actionId)`).
          </SettingsEmptyState>
        ) : null}
        {config.customActions.map((action) => (
          <SettingsRow
            key={action.id}
            searchId={`actions-custom-${action.id}`}
            title={action.label}
            description={
              action.kind === "command"
                ? action.command
                : action.kind === "prompt"
                  ? action.prompt
                  : QUICK_ACTION_UI_COMMANDS.find((cmd) => cmd.id === action.uiCommand)?.label ??
                    action.uiCommand
            }
            titleExtra={
              <>
                <span className="rounded-[5px] bg-[var(--bg-main)] px-[6px] py-[1px] font-sans text-[10.5px] uppercase tracking-[0.05em] text-[var(--text-secondary)]">
                  {action.kind}
                </span>
                {action.keybinding ? (
                  <span className="rounded-[5px] border border-[var(--border-card)] px-[6px] py-[1px] font-mono text-[10.5px] text-[var(--text-secondary)]">
                    {action.keybinding}
                  </span>
                ) : null}
                {!action.enabled ? (
                  <span className="font-sans text-[10.5px] text-[var(--text-disabled)]">
                    disabled
                  </span>
                ) : null}
              </>
            }
            trailing={
              <span className="flex items-center gap-[4px]">
                <button
                  type="button"
                  onClick={() => setEditor(editorStateFromAction(action))}
                  className="flex items-center rounded-[6px] px-[7px] py-[5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
                  title="Edit"
                  aria-label={`Edit ${action.label}`}
                >
                  <Pencil className="size-[13px]" strokeWidth={1.8} aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete(action.id)}
                  className="flex items-center rounded-[6px] px-[7px] py-[5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--status-error)]"
                  title="Delete"
                  aria-label={`Delete ${action.label}`}
                >
                  <Trash2 className="size-[13px]" strokeWidth={1.8} aria-hidden />
                </button>
              </span>
            }
          />
        ))}

        {editor != null ? (
          <SettingsBlock searchId="actions-custom-editor">
            <div className="mb-[10px] flex items-center gap-[7px] font-sans text-[12.5px] font-semibold text-[var(--text-primary)]">
              <Zap className="size-[13px] text-[var(--accent)]" strokeWidth={1.8} aria-hidden />
              {editor.editingId ? "Edit action" : "New action"}
            </div>
            <div className="grid grid-cols-1 gap-[10px] @min-[560px]:grid-cols-2">
              <div>
                <label className={fieldLabelClass} htmlFor="qa-label">
                  Label
                </label>
                <input
                  id="qa-label"
                  className={inputClass}
                  value={editor.label}
                  placeholder="e.g. Deploy preview"
                  onChange={(event) => setEditor({ ...editor, label: event.target.value })}
                />
              </div>
              <div>
                <label className={fieldLabelClass} htmlFor="qa-icon">
                  Icon
                </label>
                <select
                  id="qa-icon"
                  className={settingsSelectTriggerClass}
                  value={editor.icon}
                  onChange={(event) => setEditor({ ...editor, icon: event.target.value })}
                >
                  {QUICK_ACTION_PILL_ICON_NAMES.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={fieldLabelClass} htmlFor="qa-kind">
                  Type
                </label>
                <select
                  id="qa-kind"
                  className={settingsSelectTriggerClass}
                  value={editor.kind}
                  onChange={(event) =>
                    setEditor({ ...editor, kind: event.target.value as QuickActionKind })
                  }
                >
                  <option value="command">Run shell command</option>
                  <option value="prompt">Send agent prompt</option>
                  <option value="ui">UI command</option>
                </select>
              </div>
              <div>
                <label className={fieldLabelClass} htmlFor="qa-visibility">
                  Show when
                </label>
                <select
                  id="qa-visibility"
                  className={settingsSelectTriggerClass}
                  value={editor.visibility}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      visibility: event.target.value as QuickActionVisibility,
                    })
                  }
                >
                  {QUICK_ACTION_VISIBILITY_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mt-[10px]">
              {editor.kind === "command" ? (
                <>
                  <label className={fieldLabelClass} htmlFor="qa-command">
                    Shell command (runs at the workspace root)
                  </label>
                  <textarea
                    id="qa-command"
                    className={textareaClass}
                    value={editor.command}
                    placeholder={'e.g. gh pr merge --squash --delete-branch\nor: npm run deploy:preview'}
                    onChange={(event) => setEditor({ ...editor, command: event.target.value })}
                  />
                </>
              ) : editor.kind === "prompt" ? (
                <>
                  <label className={fieldLabelClass} htmlFor="qa-prompt">
                    Agent prompt (sent to the active conversation)
                  </label>
                  <textarea
                    id="qa-prompt"
                    className={textareaClass}
                    value={editor.prompt}
                    placeholder="e.g. Run the test suite, fix any failures, and summarize what changed."
                    onChange={(event) => setEditor({ ...editor, prompt: event.target.value })}
                  />
                </>
              ) : (
                <>
                  <label className={fieldLabelClass} htmlFor="qa-ui">
                    UI command
                  </label>
                  <select
                    id="qa-ui"
                    className={settingsSelectTriggerClass}
                    value={editor.uiCommand}
                    onChange={(event) => setEditor({ ...editor, uiCommand: event.target.value })}
                  >
                    {QUICK_ACTION_UI_COMMANDS.map((command) => (
                      <option key={command.id} value={command.id}>
                        {command.label}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>

            <div className="mt-[10px] grid grid-cols-1 gap-[10px] @min-[560px]:grid-cols-2">
              <div>
                <label className={fieldLabelClass} htmlFor="qa-keybinding">
                  Keyboard shortcut (optional)
                </label>
                <input
                  id="qa-keybinding"
                  className={`${inputClass} ${keybindingInvalid ? "!border-[var(--status-error)]" : ""}`}
                  value={editor.keybinding}
                  placeholder="e.g. Mod+Alt+M"
                  onChange={(event) => setEditor({ ...editor, keybinding: event.target.value })}
                />
                {keybindingInvalid ? (
                  <p className="mt-[3px] font-sans text-[10.5px] text-[var(--status-error)]">
                    Use a single-step binding like Mod+Alt+M, Ctrl+Shift+9, or F9.
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-[16px] pt-[16px]">
                <label className="flex items-center gap-[7px] font-sans text-[12px] text-[var(--text-primary)]">
                  <ToggleSwitch
                    checked={editor.showPill}
                    onChange={(checked) => setEditor({ ...editor, showPill: checked })}
                    size="sm"
                    variant="green"
                  />
                  Show pill
                </label>
                <label className="flex items-center gap-[7px] font-sans text-[12px] text-[var(--text-primary)]">
                  <ToggleSwitch
                    checked={editor.confirm}
                    onChange={(checked) => setEditor({ ...editor, confirm: checked })}
                    size="sm"
                    variant="green"
                  />
                  Confirm before run
                </label>
                <label className="flex items-center gap-[7px] font-sans text-[12px] text-[var(--text-primary)]">
                  <ToggleSwitch
                    checked={editor.enabled}
                    onChange={(checked) => setEditor({ ...editor, enabled: checked })}
                    size="sm"
                    variant="green"
                  />
                  Enabled
                </label>
              </div>
            </div>

            {saveError ? (
              <SettingsCallout tone="danger" className="mt-[10px]">
                {saveError}
              </SettingsCallout>
            ) : null}

            <div className="mt-[12px] flex items-center gap-[8px]">
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={saving || editorPayloadInvalid || keybindingInvalid}
                className="rounded-[var(--radius-tab)] bg-[var(--accent)] px-[13px] py-[6px] font-sans text-[12px] font-medium text-[var(--bg-main)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? "Saving…" : editor.editingId ? "Save changes" : "Create action"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditor(null);
                  setSaveError(null);
                }}
                className="rounded-[var(--radius-tab)] border border-[var(--border-card)] px-[13px] py-[6px] font-sans text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]"
              >
                Cancel
              </button>
            </div>
          </SettingsBlock>
        ) : null}
      </SettingsSection>
    </>
  );
}

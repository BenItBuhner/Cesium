"use client";

import {
  FOLDER_COLOR_OPTIONS,
  FOLDER_ICON_OPTIONS,
  isValidFolderColor,
  WorkspaceFolderIcon,
} from "@/lib/workspace-rail-appearance";

/**
 * Inline icon / color / name editor shared by the workspace rail (folders,
 * workspace headers) and the device picker (servers, Codespace devices).
 * Renders as a small card meant to expand directly under the row it edits.
 */
export function RailIconCustomizePanel({
  title,
  icon,
  color,
  showNameField,
  name,
  nameFieldLabel = "Folder name",
  allowEmptyName = false,
  onClose,
  onUpdate,
}: {
  title: string;
  icon: string;
  color: string;
  showNameField: boolean;
  name?: string;
  nameFieldLabel?: string;
  allowEmptyName?: boolean;
  onClose: () => void;
  onUpdate: (patch: { icon?: string; color?: string; name?: string }) => void;
}) {
  return (
    <div className="ml-[13px] mt-[3px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] p-[8px] shadow-[0_12px_40px_rgba(0,0,0,0.22)]">
      <div className="flex items-center gap-[8px]">
        <div
          className="flex size-[28px] shrink-0 items-center justify-center rounded-[var(--agent-control-radius)] border border-[var(--border-subtle)]"
          style={{ color }}
          aria-hidden
        >
          <WorkspaceFolderIcon iconName={icon} className="size-[16px]" strokeWidth={1.8} />
        </div>
        {showNameField ? (
          <input
            value={name ?? ""}
            maxLength={80}
            aria-label={nameFieldLabel}
            className="h-[28px] min-w-0 flex-1 rounded-[var(--agent-control-radius)] border border-[var(--border-subtle)] bg-[var(--bg-main)] px-[8px] font-sans text-[12px] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-disabled)] focus:border-[var(--accent)]"
            onChange={(event) => {
              const nextName = event.target.value.slice(0, 80);
              onUpdate({ name: allowEmptyName ? nextName : nextName || "Folder" });
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
              if (event.key === "Enter") {
                event.preventDefault();
                onClose();
              }
            }}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate font-sans text-[12px] font-medium text-[var(--text-primary)]">
            {title}
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          className="h-[28px] shrink-0 rounded-[var(--agent-control-radius)] px-[8px] font-sans text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
        >
          Done
        </button>
      </div>

      <div className="mt-[8px] grid grid-cols-7 gap-[4px]" aria-label="Icon palette">
        {FOLDER_ICON_OPTIONS.map(({ name: iconName, Icon }) => {
          const selected = icon === iconName;
          return (
            <button
              key={iconName}
              type="button"
              onClick={() => onUpdate({ icon: iconName })}
              className={`flex size-[24px] items-center justify-center rounded-[var(--agent-control-radius)] border transition-colors ${
                selected
                  ? "border-[var(--accent)] bg-[var(--accent-bg)] text-[var(--text-primary)]"
                  : "border-transparent text-[var(--text-secondary)] hover:border-[var(--border-subtle)] hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
              }`}
              title={iconName}
              aria-label={`Use ${iconName} icon`}
              aria-pressed={selected}
            >
              <Icon className="size-[14px]" strokeWidth={1.8} />
            </button>
          );
        })}
      </div>

      <div className="mt-[8px] flex items-center gap-[6px]">
        <div className="flex min-w-0 flex-1 flex-wrap gap-[4px]" aria-label="Color palette">
          {FOLDER_COLOR_OPTIONS.map((swatchColor) => (
            <button
              key={swatchColor}
              type="button"
              onClick={() => onUpdate({ color: swatchColor })}
              className={`size-[var(--d2-rail-control-size)] rounded-full border transition-transform hover:scale-110 ${
                color.toLowerCase() === swatchColor.toLowerCase()
                  ? "border-[var(--text-primary)]"
                  : "border-[var(--border-card)]"
              }`}
              style={{ backgroundColor: swatchColor }}
              title={swatchColor}
              aria-label={`Use ${swatchColor} color`}
              aria-pressed={color.toLowerCase() === swatchColor.toLowerCase()}
            />
          ))}
        </div>
        <label className="flex shrink-0 items-center gap-[5px] rounded-[var(--agent-control-radius)] border border-[var(--border-subtle)] bg-[var(--bg-main)] px-[6px] py-[3px] font-sans text-[11px] text-[var(--text-secondary)]">
          Custom
          <input
            type="color"
            value={isValidFolderColor(color) ? color : "#7c3aed"}
            onChange={(event) => onUpdate({ color: event.target.value })}
            className="size-[var(--d2-rail-control-size)] cursor-pointer border-0 bg-transparent p-0"
            aria-label="Custom color"
          />
        </label>
      </div>
    </div>
  );
}

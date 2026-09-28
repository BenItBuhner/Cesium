"use client";

import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, PackageOpen } from "lucide-react";
import { useClickOutside } from "@/hooks/useClickOutside";
import { usePopover } from "@/hooks/usePopover";
import {
  popoverMenuFixedPanelClass,
  popoverMenuItemClass,
  popoverMenuListClass,
  popoverMenuSectionLabelClass,
} from "@/components/ui/popover-menu-ui";
import type { ModelInfo } from "@/lib/types";

export type PlanBuildModelChoice = "inherit" | string;

export type PlanBuildRequest = {
  modelChoice: PlanBuildModelChoice;
};

type PlanBuildControlsProps = {
  models: ModelInfo[];
  currentModel?: ModelInfo | null;
  modelChoice: PlanBuildModelChoice;
  onModelChoiceChange: (choice: PlanBuildModelChoice) => void;
  onBuild: (request: PlanBuildRequest) => void;
  compact?: boolean;
};

function modelKey(model: ModelInfo): string {
  return model.modelValue ?? model.id;
}

function labelForModelChoice(
  choice: PlanBuildModelChoice,
  models: ModelInfo[],
  currentModel?: ModelInfo | null
): string {
  if (choice === "inherit") {
    return currentModel ? `Inherit (${currentModel.name})` : "Inherit";
  }
  const found = models.find((model) => modelKey(model) === choice);
  return found?.name ?? choice;
}

function menuStyle(position: ReturnType<typeof usePopover>["position"]) {
  return {
    ...(position.top != null ? { top: position.top } : { bottom: position.bottom }),
    left: position.left,
    maxHeight: position.maxHeight,
  };
}

export function PlanBuildControls({
  models,
  currentModel,
  modelChoice,
  onModelChoiceChange,
  onBuild,
  compact = false,
}: PlanBuildControlsProps) {
  const [modelOpen, setModelOpen] = useState(false);
  const closeModel = useCallback(() => setModelOpen(false), []);
  const {
    triggerRef: modelTriggerRef,
    popoverRef: modelPopoverRef,
    position: modelPosition,
    ready: modelReady,
  } = usePopover(modelOpen, { placement: "above" });

  useClickOutside(modelTriggerRef, closeModel, modelOpen, [modelPopoverRef]);

  const visibleModels = useMemo(() => models.slice(0, 60), [models]);
  const modelLabel = labelForModelChoice(modelChoice, models, currentModel);

  const build = useCallback(() => onBuild({ modelChoice }), [modelChoice, onBuild]);

  return (
    <div className="flex min-w-0 items-center justify-end gap-[6px]">
      <div ref={modelTriggerRef} className="relative min-w-0">
        <button
          type="button"
          onClick={() => setModelOpen((open) => !open)}
          className={`inline-flex max-w-[220px] items-center gap-[6px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[9px] font-sans text-[11px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)] ${
            compact ? "h-[26px]" : "h-[30px]"
          }`}
          title={`Model: ${modelLabel}`}
          aria-label={`Plan build model: ${modelLabel}`}
        >
          <PackageOpen className="size-[13px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.5} />
          <span className="min-w-0 truncate">{modelLabel}</span>
          <ChevronDown className="size-[10px] shrink-0 text-[var(--text-secondary)]" strokeWidth={2} />
        </button>
        {modelOpen &&
          createPortal(
            <div
              ref={modelPopoverRef}
              className={`${popoverMenuFixedPanelClass} w-[280px] transition-opacity ${
                modelReady ? "opacity-100" : "opacity-0"
              }`}
              style={menuStyle(modelPosition)}
              data-ide-input-sink
              data-ide-composer-floating-popover
              onPointerDown={(event) => event.stopPropagation()}
              onWheel={(event) => event.stopPropagation()}
            >
              <div className={popoverMenuListClass}>
                <p className={popoverMenuSectionLabelClass}>Implementation model</p>
                <button
                  type="button"
                  className={popoverMenuItemClass}
                  onClick={() => {
                    onModelChoiceChange("inherit");
                    closeModel();
                  }}
                >
                  <span className="min-w-0 truncate">Inherit planning model</span>
                  {modelChoice === "inherit" ? <Check className="size-[13px]" strokeWidth={2} /> : null}
                </button>
                <div className="my-[4px] h-px bg-[var(--border-card)]" />
                <div className="hide-scrollbar-y max-h-[300px] overflow-y-auto">
                  {visibleModels.map((model) => {
                    const value = modelKey(model);
                    const active = value === modelChoice;
                    return (
                      <button
                        key={value}
                        type="button"
                        className={popoverMenuItemClass}
                        onClick={() => {
                          onModelChoiceChange(value);
                          closeModel();
                        }}
                      >
                        <span className="min-w-0 truncate">{model.name}</span>
                        {active ? <Check className="size-[13px]" strokeWidth={2} /> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>,
            document.body
          )}
      </div>

      <button
        type="button"
        onClick={build}
        className={`rounded-[var(--radius-tab)] bg-[var(--plan-accent)] px-[11px] font-sans text-[11px] font-medium text-[var(--bg-panel)] transition-opacity hover:opacity-90 ${
          compact ? "h-[26px]" : "h-[30px]"
        }`}
      >
        Build
      </button>
    </div>
  );
}

export function modelChoiceToOverride(
  choice: PlanBuildModelChoice,
  models: ModelInfo[],
  fallback?: ModelInfo | null
): Pick<ModelInfo, "id" | "name" | "modelValue"> | null {
  const target =
    choice === "inherit"
      ? fallback ?? null
      : models.find((model) => modelKey(model) === choice) ?? null;
  if (!target) return null;
  return {
    id: target.id,
    name: target.name,
    modelValue: target.modelValue,
  };
}

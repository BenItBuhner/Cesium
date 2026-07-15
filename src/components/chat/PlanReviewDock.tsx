"use client";

import { ListChecks, X } from "lucide-react";
import {
  PlanBuildControls,
  type PlanBuildModelChoice,
  type PlanBuildRequest,
} from "@/components/chat/PlanBuildControls";
import type { ModelInfo } from "@/lib/types";


export type DockedPlanFile = {
  path: string;
  title: string;
};

interface PlanReviewDockProps {
  plan: DockedPlanFile;
  models: ModelInfo[];
  currentModel?: ModelInfo | null;
  modelChoice: PlanBuildModelChoice;
  onModelChoiceChange: (choice: PlanBuildModelChoice) => void;
  onBuild: (request: PlanBuildRequest) => void;
  onDismiss: () => void;
}

export function PlanReviewDock({
  plan,
  models,
  currentModel,
  modelChoice,
  onModelChoiceChange,
  onBuild,
  onDismiss,
}: PlanReviewDockProps) {
  return (
    <div className="mx-[12px] rounded-t-[var(--radius-card)] rounded-b-none border-x border-t border-[var(--border-card)] bg-[var(--bg-card)] p-[10px]">
      <div className="flex min-w-0 items-start gap-[9px]">
        <ListChecks className="mt-[2px] size-[14px] shrink-0 text-[var(--plan-accent)]" strokeWidth={1.5} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-[6px]">
            <p className="min-w-0 truncate font-sans text-[13px] font-medium text-[var(--text-primary)]">
              {plan.title}
            </p>
          </div>
          <p className="mt-[3px] truncate font-sans text-[11px] text-[var(--text-secondary)]">
            {plan.path}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="flex size-[22px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
          aria-label="Dismiss plan card"
        >
          <X className="size-[13px]" strokeWidth={1.5} />
        </button>
      </div>
      <div className="mt-[9px] border-t border-[var(--border-card)] pt-[8px]">
        <PlanBuildControls
          models={models}
          currentModel={currentModel}
          modelChoice={modelChoice}
          onModelChoiceChange={onModelChoiceChange}
          onBuild={onBuild}
        />
      </div>
    </div>
  );
}

"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Maximize2,
  Minimize2,
} from "lucide-react";
import type { AskQuestionOption, AskQuestionStep } from "@/lib/types";
import { CollapsibleHeight } from "./CollapsibleHeight";

const transitionSnappy =
  "duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none motion-reduce:duration-0";

function scrollChatDown(px = 96) {
  const root = document.querySelector<HTMLElement>("[data-chat-scroll-root]");
  root?.scrollBy({ top: px, behavior: "smooth" });
}

interface AskQuestionCardProps {
  steps: AskQuestionStep[];
  /** When true, docked above composer: outer chrome for solo dock. */
  dockAboveComposer?: boolean;
  /** Bottom section of combined dock when stacked with other chrome. */
  embeddedInDock?: boolean;
}

export function AskQuestionCard({
  steps,
  dockAboveComposer,
  embeddedInDock,
}: AskQuestionCardProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [selectedLetter, setSelectedLetter] = useState<string | null>(null);
  const [otherDraft, setOtherDraft] = useState("");
  const [minimized, setMinimized] = useState(false);
  const otherInputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const step = steps[stepIndex];
  const total = steps.length;
  const stepNo = stepIndex + 1;

  useEffect(() => {
    setSelectedLetter(null);
    setOtherDraft("");
  }, [stepIndex]);

  const goNext = useCallback(() => {
    if (stepIndex < total - 1) {
      setStepIndex((i) => i + 1);
      scrollChatDown();
      requestAnimationFrame(() => {
        bodyRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    }
  }, [stepIndex, total]);

  const goPrev = useCallback(() => {
    if (stepIndex > 0) setStepIndex((i) => i - 1);
  }, [stepIndex]);

  const selectOption = useCallback((opt: AskQuestionOption) => {
    setSelectedLetter(opt.letter);
    if (opt.isOther) {
      requestAnimationFrame(() => otherInputRef.current?.focus());
    }
  }, []);

  const tryAdvance = useCallback(() => {
    if (!selectedLetter || !step) return;
    const opt = step.options.find((o) => o.letter === selectedLetter);
    if (!opt) return;
    if (opt.isOther) {
      if (!otherDraft.trim()) return;
    }
    goNext();
  }, [selectedLetter, step, otherDraft, goNext]);

  const frame = embeddedInDock
    ? "flex flex-col overflow-hidden px-[8px] pb-[8px] pt-[6px]"
    : `flex flex-col overflow-hidden ${
        dockAboveComposer
          ? "mx-[12px] rounded-t-[var(--radius-card)] rounded-b-none border border-[var(--border-card)] bg-[var(--bg-card)] p-[10px]"
          : "mx-[10px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] p-[10px]"
      }`;

  if (!step) return null;

  const navDisabledPrev = stepIndex === 0;
  const navDisabledNext = stepIndex >= total - 1;

  const headerToolbar = (
    <div className="flex min-w-0 items-center gap-[4px]">
      <span
        className={`shrink-0 overflow-hidden whitespace-nowrap font-mono text-[10px] tabular-nums text-[var(--text-secondary)] transition-[opacity,max-width,margin,padding] ${transitionSnappy} ${
          minimized ? "max-w-0 opacity-0" : "max-w-[48px] opacity-100"
        }`}
        aria-hidden={minimized}
      >
        {stepNo}/{total}
      </span>
      <button
        type="button"
        onClick={goPrev}
        disabled={navDisabledPrev}
        className={`flex size-[24px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] outline-none ring-0 transition-colors duration-150 ease-out hover:bg-white/[0.06] hover:text-[var(--plan-accent)] focus-visible:outline-none focus-visible:ring-0 motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-25`}
        aria-label="Previous question"
      >
        <ChevronLeft className="size-[14px]" strokeWidth={1.5} />
      </button>
      <button
        type="button"
        onClick={goNext}
        disabled={navDisabledNext}
        className={`flex size-[24px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] outline-none ring-0 transition-colors duration-150 ease-out hover:bg-white/[0.06] hover:text-[var(--plan-accent)] focus-visible:outline-none focus-visible:ring-0 motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-25`}
        aria-label="Next question"
      >
        <ChevronRight className="size-[14px]" strokeWidth={1.5} />
      </button>
      <button
        type="button"
        onClick={() => setMinimized((m) => !m)}
        className={`flex size-[24px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] outline-none ring-0 transition-colors duration-150 ease-out hover:bg-white/[0.06] hover:text-[var(--plan-accent)] focus-visible:outline-none focus-visible:ring-0 motion-reduce:transition-none`}
        aria-label={minimized ? "Expand questions" : "Minimize questions"}
      >
        <span className="relative flex size-[13px] items-center justify-center">
          <Maximize2
            className={`absolute size-[13px] transition-[opacity,transform] ${transitionSnappy} ${
              minimized ? "scale-100 rotate-0 opacity-100" : "scale-50 rotate-90 opacity-0"
            }`}
            strokeWidth={1.5}
            aria-hidden
          />
          <Minimize2
            className={`absolute size-[13px] transition-[opacity,transform] ${transitionSnappy} ${
              minimized ? "scale-50 -rotate-90 opacity-0" : "scale-100 rotate-0 opacity-100"
            }`}
            strokeWidth={1.5}
            aria-hidden
          />
        </span>
      </button>
    </div>
  );

  return (
    <div
      className={frame}
      onKeyDown={(e) => {
        if (e.key !== "Enter" || e.defaultPrevented) return;
        const t = e.target as HTMLElement;
        if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
        e.preventDefault();
        tryAdvance();
      }}
      role="presentation"
    >
      <div
        className={`flex items-center gap-[6px] transition-[padding] ${transitionSnappy} ${
          minimized ? "pb-0" : "pb-[6px]"
        }`}
      >
        <CircleHelp
          className="size-[14px] shrink-0 text-[var(--plan-accent)]"
          strokeWidth={1.5}
          aria-hidden
        />
        <div className="relative min-h-[20px] min-w-0 flex-1">
          <span
            className={`absolute inset-0 flex min-w-0 items-center truncate font-sans text-[13px] font-normal text-[var(--plan-accent-label-strong)] transition-[opacity,transform] ${transitionSnappy} ${
              minimized
                ? "z-[1] translate-y-0 opacity-100"
                : "z-0 translate-y-[-3px] opacity-0"
            }`}
            aria-hidden={!minimized}
          >
            Questions · {stepNo}/{total}
          </span>
          <span
            className={`absolute inset-0 flex min-w-0 items-center truncate font-sans text-[13px] font-normal text-[var(--plan-accent-label-strong)] transition-[opacity,transform] ${transitionSnappy} ${
              !minimized
                ? "z-[1] translate-y-0 opacity-100"
                : "z-0 translate-y-[3px] opacity-0"
            }`}
            aria-hidden={minimized}
          >
            {step.title}
          </span>
        </div>
        {headerToolbar}
      </div>

      <CollapsibleHeight open={!minimized} className="min-h-0">
        <div ref={bodyRef} className="flex flex-col gap-[6px]">
          {step.options.map((opt) => {
            const selected = selectedLetter === opt.letter;
            const rowClass = selected
              ? "rounded-[6px] bg-[var(--plan-accent-selected-bg)] transition-[background-color] duration-150 ease-out motion-reduce:transition-none"
              : "rounded-[6px] transition-[background-color] duration-150 ease-out motion-reduce:transition-none";

            const badgeClass = selected
              ? "border-[var(--plan-accent)] bg-[var(--plan-accent-bg)] text-[var(--plan-accent)]"
              : "border-[var(--border-card)] text-white";

            const textClass = selected
              ? "text-[var(--plan-accent-label-strong)]"
              : "text-white";

            const subClass = selected
              ? "text-[var(--plan-accent-label)]"
              : "text-[var(--text-secondary)]";

            const otherOpen = Boolean(opt.isOther && selected);

            const optionKeyHandlers = (e: KeyboardEvent) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              if (selectedLetter !== opt.letter) {
                selectOption(opt);
                return;
              }
              if (opt.isOther) {
                if (otherDraft.trim()) goNext();
                else otherInputRef.current?.focus();
              } else {
                goNext();
              }
            };

            const labelInner = (
              <>
                <span
                  className={`flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-[var(--radius-checkbox)] border font-sans text-[7px] font-normal leading-none transition-[color,background-color,border-color] duration-150 ease-out motion-reduce:transition-none ${badgeClass}`}
                >
                  {opt.letter}
                </span>
                <span className="min-w-0 text-left">
                  <span
                    className={`font-sans text-[10.5px] font-normal leading-snug ${textClass}`}
                  >
                    {opt.isOther ? (
                      <>
                        {opt.text}
                        {!selected ? (
                          <span className={subClass}>
                            {" "}
                            {opt.placeholder}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      opt.text
                    )}
                  </span>
                </span>
              </>
            );

            return (
              <div key={opt.letter} className={`${rowClass} px-[6px] py-[5px]`}>
                {opt.isOther ? (
                  <div className="flex w-full min-w-0 items-center gap-[8px]">
                    <button
                      type="button"
                      onClick={() => selectOption(opt)}
                      onKeyDown={optionKeyHandlers}
                      className="flex shrink-0 cursor-pointer items-center gap-[8px] rounded-[4px] py-[2px] text-left outline-none ring-0 transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-0"
                    >
                      {labelInner}
                    </button>
                    {otherOpen ? (
                      <input
                        ref={otherInputRef}
                        type="text"
                        value={otherDraft}
                        onChange={(e) => setOtherDraft(e.target.value)}
                        placeholder={opt.placeholder}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            e.stopPropagation();
                            if (otherDraft.trim()) goNext();
                          }
                        }}
                        className="box-border min-h-[26px] min-w-0 flex-1 rounded-[4px] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[8px] py-[4px] text-left font-sans text-[10.5px] text-[var(--plan-accent-label-strong)] outline-none ring-0 transition-[border-color,box-shadow] duration-150 ease-out placeholder:text-[var(--plan-accent-label)] placeholder:opacity-60 focus:border-[var(--border-card)] focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 motion-reduce:transition-none"
                      />
                    ) : null}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => selectOption(opt)}
                    onKeyDown={optionKeyHandlers}
                    className="flex w-full min-w-0 cursor-pointer items-center gap-[8px] rounded-[4px] text-left outline-none ring-0 transition-[background-color,color] duration-150 ease-out hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-0 motion-reduce:transition-none"
                  >
                    {labelInner}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </CollapsibleHeight>
    </div>
  );
}

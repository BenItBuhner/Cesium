"use client";

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { HardwareAwareTextInput } from "@/components/input/HardwareAwareTextField";
import type { AskQuestionOption, AskQuestionStep } from "@/lib/types";
import { CollapsibleHeight } from "./CollapsibleHeight";

const transitionSnappy =
  "duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none motion-reduce:duration-0";

const slideTransition =
  "transition-[transform] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none motion-reduce:duration-0";

const heightTransition =
  "transition-[height] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none motion-reduce:duration-0";

/** Only treat as typing context when the event target is inside a real text field (not sidebar buttons). */
function keyEventTargetIsInTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      'input, textarea, [contenteditable="true"], [data-hardware-input-surface]'
    )
  );
}

type StepUi = { letter: string | null; otherDraft: string };

function QuestionStepColumn({
  step,
  selectedLetter,
  otherDraft,
  patchUi,
  selectOption,
  goNext,
  otherRefs,
  registerOptionButton,
}: {
  step: AskQuestionStep;
  selectedLetter: string | null;
  otherDraft: string;
  patchUi: (id: string, patch: Partial<StepUi>) => void;
  selectOption: (stepId: string, opt: AskQuestionOption) => void;
  goNext: () => void;
  otherRefs: MutableRefObject<Partial<Record<string, HTMLElement | null>>>;
  registerOptionButton: (letter: string, el: HTMLButtonElement | null) => void;
}) {
  return (
    <div className="min-w-0 max-w-full">
      {step.content ? (
        <p className="mb-[8px] font-sans text-[11.5px] font-normal leading-snug text-[var(--text-secondary)]">
          {step.content}
        </p>
      ) : null}
      <div className="flex flex-col gap-[6px]">
        {step.options.map((opt) => {
          const selected = selectedLetter === opt.letter;
          const rowClass = selected
            ? "rounded-[6px] bg-[var(--plan-accent-selected-bg)] transition-[background-color] duration-150 ease-out motion-reduce:transition-none"
            : "rounded-[6px] transition-[background-color] duration-150 ease-out motion-reduce:transition-none hover:bg-[var(--accent-bg)]";

          const badgeClass = selected
            ? "border-[var(--plan-accent)] bg-[var(--plan-accent-bg)] text-[var(--plan-accent)]"
            : "border-[var(--border-card)] text-[var(--text-primary)]";

          const textClass = selected
            ? "text-[var(--plan-accent-label-strong)]"
            : "text-[var(--text-primary)]";

          const subClass = selected
            ? "text-[var(--plan-accent-label)]"
            : "text-[var(--text-secondary)]";

          const otherOpen = Boolean(opt.isOther && selected);

          const optionKeyHandlers = (e: KeyboardEvent) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (selectedLetter !== opt.letter) {
              selectOption(step.id, opt);
              return;
            }
            if (opt.isOther) {
              if (otherDraft.trim()) goNext();
              else otherRefs.current[step.id]?.focus();
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
                    ref={(el) => registerOptionButton(opt.letter, el)}
                    type="button"
                    onClick={() => selectOption(step.id, opt)}
                    onKeyDown={optionKeyHandlers}
                    className="flex min-w-0 shrink-0 cursor-pointer items-center gap-[8px] rounded-[4px] py-[2px] text-left outline-none ring-0 focus-visible:outline-none focus-visible:ring-0"
                  >
                    {labelInner}
                  </button>
                  {otherOpen ? (
                    <HardwareAwareTextInput
                      inputRef={{
                        get current() {
                          return otherRefs.current[step.id] ?? null;
                        },
                        set current(value: HTMLElement | null) {
                          otherRefs.current[step.id] = value;
                        },
                      }}
                      value={otherDraft}
                      onChange={(value) => patchUi(step.id, { otherDraft: value })}
                      placeholder={opt.placeholder}
                      onNativeKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          e.stopPropagation();
                          if (otherDraft.trim()) goNext();
                        }
                      }}
                      onHardwareKeyDown={(event) => {
                        if (event.key !== "Enter") return false;
                        event.preventDefault();
                        if (otherDraft.trim()) goNext();
                        return true;
                      }}
                      className="box-border min-h-[26px] min-w-0 flex-1 rounded-[4px] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[8px] py-[4px] text-left font-sans text-[10.5px] text-[var(--plan-accent-label-strong)] outline-none ring-0 transition-[border-color,box-shadow] duration-150 ease-out placeholder:text-[var(--plan-accent-label)] placeholder:opacity-60 focus:border-[var(--border-card)] focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 motion-reduce:transition-none"
                      ariaLabel={opt.placeholder}
                    />
                  ) : null}
                </div>
              ) : (
                <button
                  ref={(el) => registerOptionButton(opt.letter, el)}
                  type="button"
                  onClick={() => selectOption(step.id, opt)}
                  onKeyDown={optionKeyHandlers}
                  className="flex w-full min-w-0 cursor-pointer items-center gap-[8px] rounded-[4px] text-left outline-none ring-0 focus-visible:outline-none focus-visible:ring-0"
                >
                  {labelInner}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
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
  const [stepUi, setStepUi] = useState<Record<string, StepUi>>({});
  const [minimized, setMinimized] = useState(false);
  const otherRefs = useRef<Partial<Record<string, HTMLElement | null>>>({});
  const optionButtonRefs = useRef<
    Partial<Record<string, Partial<Record<string, HTMLButtonElement | null>>>>
  >({});
  /** Measures only the active step so card height ignores off-screen slides (slides are absolutely laid out). */
  const activeSlideMeasureRef = useRef<HTMLDivElement>(null);
  const [bodyHeight, setBodyHeight] = useState<number | null>(null);
  const stepUiRef = useRef(stepUi);

  useLayoutEffect(() => {
    stepUiRef.current = stepUi;
  }, [stepUi]);

  useLayoutEffect(() => {
    const el = activeSlideMeasureRef.current;
    if (!el) return;
    const measure = () => setBodyHeight(el.scrollHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [stepIndex]);

  const getUi = useCallback(
    (id: string): StepUi => stepUi[id] ?? { letter: null, otherDraft: "" },
    [stepUi]
  );

  const patchUi = useCallback((id: string, patch: Partial<StepUi>) => {
    setStepUi((prev) => {
      const cur = prev[id] ?? { letter: null, otherDraft: "" };
      return { ...prev, [id]: { ...cur, ...patch } };
    });
  }, []);

  const goNext = useCallback(() => {
    if (stepIndex < steps.length - 1) {
      setStepIndex((i) => i + 1);
    }
  }, [stepIndex, steps.length]);

  const goPrev = useCallback(() => {
    if (stepIndex > 0) setStepIndex((i) => i - 1);
  }, [stepIndex]);

  const selectOption = useCallback(
    (
      stepId: string,
      opt: AskQuestionOption,
      options?: { focusOther?: boolean }
    ) => {
      patchUi(stepId, { letter: opt.letter });
      if (opt.isOther && options?.focusOther !== false) {
        requestAnimationFrame(() => otherRefs.current[stepId]?.focus());
      }
    },
    [patchUi]
  );

  const tryAdvance = useCallback(() => {
    const st = steps[stepIndex];
    if (!st) return;
    const u = stepUiRef.current[st.id] ?? { letter: null, otherDraft: "" };
    if (!u.letter) return;
    const opt = st.options.find((o) => o.letter === u.letter);
    if (!opt) return;
    if (opt.isOther && !u.otherDraft.trim()) return;
    goNext();
  }, [stepIndex, steps, goNext]);

  const registerOptionButton = useCallback(
    (stepId: string, letter: string, el: HTMLButtonElement | null) => {
      const stepButtons = optionButtonRefs.current[stepId] ?? {};
      stepButtons[letter] = el;
      optionButtonRefs.current[stepId] = stepButtons;
    },
    []
  );

  if (steps.length === 0) return null;

  const step = steps[stepIndex];
  const stepNo = stepIndex + 1;

  const frameBase =
    "flex flex-col overflow-hidden";

  const frame = embeddedInDock
    ? `${frameBase} px-[8px] pb-[8px] pt-[6px]`
    : dockAboveComposer
      ? `${frameBase} mx-[12px] rounded-t-[var(--radius-card)] rounded-b-none border-x border-t border-[var(--border-card)] bg-[var(--bg-card)] p-[10px]`
      : `${frameBase} mx-[10px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] p-[10px]`;

  const navDisabledPrev = stepIndex === 0;
  const navDisabledNext = stepIndex >= steps.length - 1;

  const headerToolbar = (
    <div className="flex min-w-0 items-center gap-[4px]">
      <span
        className={`shrink-0 overflow-hidden whitespace-nowrap font-mono text-[10px] tabular-nums text-[var(--text-secondary)] transition-[opacity,max-width,margin,padding] ${transitionSnappy} ${
          minimized ? "max-w-0 opacity-0" : "max-w-[48px] opacity-100"
        }`}
        aria-hidden={minimized}
      >
        {stepNo}/{steps.length}
      </span>
      {!minimized ? (
        <>
          <button
            type="button"
            onClick={goPrev}
            disabled={navDisabledPrev}
            className={`flex size-[24px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] outline-none ring-0 transition-colors duration-150 ease-out hover:bg-[var(--accent-bg)] hover:text-[var(--plan-accent)] focus-visible:outline-none focus-visible:ring-0 motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-25`}
            aria-label="Previous question"
          >
            <ChevronLeft className="size-[14px]" strokeWidth={1.5} />
          </button>
          <button
            type="button"
            onClick={goNext}
            disabled={navDisabledNext}
            className={`flex size-[24px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] outline-none ring-0 transition-colors duration-150 ease-out hover:bg-[var(--accent-bg)] hover:text-[var(--plan-accent)] focus-visible:outline-none focus-visible:ring-0 motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-25`}
            aria-label="Next question"
          >
            <ChevronRight className="size-[14px]" strokeWidth={1.5} />
          </button>
        </>
      ) : null}
      <button
        type="button"
        onClick={() => setMinimized((m) => !m)}
        className={`flex size-[24px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] outline-none ring-0 transition-colors duration-150 ease-out hover:bg-[var(--accent-bg)] hover:text-[var(--plan-accent)] focus-visible:outline-none focus-visible:ring-0 motion-reduce:transition-none`}
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

  const trackWidthPercent = steps.length * 100;
  const trackOffsetPercent = (stepIndex * 100) / steps.length;
  const stepWidthPercent = 100 / steps.length;
  const currentUi = getUi(step.id);

  function moveOptionSelection(direction: -1 | 1) {
    const currentIndex = step.options.findIndex(
      (opt) => opt.letter === currentUi.letter
    );
    const fallbackIndex = direction > 0 ? 0 : step.options.length - 1;
    const nextIndex =
      currentIndex === -1
        ? fallbackIndex
        : Math.max(0, Math.min(step.options.length - 1, currentIndex + direction));
    const nextOption = step.options[nextIndex];
    if (!nextOption) return;
    selectOption(step.id, nextOption, { focusOther: false });
    requestAnimationFrame(() => {
      optionButtonRefs.current[step.id]?.[nextOption.letter]?.focus();
    });
  }

  return (
    <div
      className={frame}
      onKeyDown={(e) => {
        const t = e.target;
        // Only when focus is inside this card (bubbling); never steal arrows / Enter from text fields.
        if (keyEventTargetIsInTextField(t)) return;

        if (e.key === "ArrowLeft") {
          if (navDisabledPrev) return;
          e.preventDefault();
          goPrev();
          return;
        }
        if (e.key === "ArrowRight") {
          if (navDisabledNext) return;
          e.preventDefault();
          goNext();
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          moveOptionSelection(-1);
          return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          moveOptionSelection(1);
          return;
        }

        if (e.key === "Enter" && !e.defaultPrevented) {
          if (
            t instanceof HTMLElement &&
            t.closest("button, a[href]")
          ) {
            return;
          }
          e.preventDefault();
          tryAdvance();
        }
      }}
      role="presentation"
    >
      <div
        className={`flex min-w-0 items-center gap-[6px] transition-[padding] ${transitionSnappy} ${
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
            Questions · {stepNo}/{steps.length}
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
        <div className="min-h-0 overflow-hidden">
          <div
            className={`overflow-hidden ${heightTransition}`}
            style={{ height: bodyHeight === null ? "auto" : bodyHeight }}
          >
            <div
              className={`relative ${slideTransition}`}
              style={{
                width: `${trackWidthPercent}%`,
                transform: `translateX(-${trackOffsetPercent}%)`,
              }}
            >
              {steps.map((s, i) => {
                const u = getUi(s.id);
                const isActive = i === stepIndex;
                return (
                  <div
                    key={s.id}
                    ref={isActive ? activeSlideMeasureRef : undefined}
                    className="absolute top-0"
                    style={{
                      width: `${stepWidthPercent}%`,
                      left: `${(i * 100) / steps.length}%`,
                    }}
                  >
                    <QuestionStepColumn
                      step={s}
                      selectedLetter={u.letter}
                      otherDraft={u.otherDraft}
                      patchUi={patchUi}
                      selectOption={selectOption}
                      goNext={goNext}
                      otherRefs={otherRefs}
                      registerOptionButton={(letter, el) =>
                        registerOptionButton(s.id, letter, el)
                      }
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </CollapsibleHeight>
    </div>
  );
}

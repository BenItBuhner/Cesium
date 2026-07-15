"use client";

import { useState } from "react";
import { Ban, Check, Circle, LoaderCircle, Maximize2, Minimize2 } from "lucide-react";
import type { TodoItem } from "@/lib/types";
import { CollapsibleHeight } from "./CollapsibleHeight";

const transitionSnappy =
  "duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none motion-reduce:duration-0";
const TODO_PROGRESS_ICON_SIZE = 18;
const TODO_PROGRESS_ICON_RADIUS = 7;
const TODO_PROGRESS_ICON_STROKE = 2;
const TODO_PROGRESS_ICON_CIRCUMFERENCE = 2 * Math.PI * TODO_PROGRESS_ICON_RADIUS;

interface TodoCardProps {
  label: string;
  todos: TodoItem[];
  /** When true, square top corners and omit top border to stack under the user bubble. */
  meldUserAbove?: boolean;
  /** Sticky header under the latest user message; minimized by default. */
  embeddedInSticky?: boolean;
}

export function TodoIcon({ status }: { status: TodoItem["status"] }) {
  if (status === "in_progress") {
    return (
      <LoaderCircle
        className="size-[18px] shrink-0 text-[var(--text-secondary)] animate-spin"
        strokeWidth={1.5}
        aria-hidden
      />
    );
  }
  if (status === "completed") {
    return (
      <Check
        className="size-[18px] shrink-0 text-[var(--text-secondary)]"
        strokeWidth={1.5}
        aria-hidden
      />
    );
  }
  if (status === "blocked") {
    return (
      <Ban
        className="size-[18px] shrink-0 text-[#f59e0b]"
        strokeWidth={1.5}
        aria-hidden
      />
    );
  }
  return (
    <Circle
      className="size-[18px] shrink-0 text-[var(--text-secondary)]"
      strokeWidth={1.5}
      aria-hidden
    />
  );
}

function todoCompletionRatio(todos: TodoItem[]): number {
  if (todos.length === 0) {
    return 0;
  }
  const completed = todos.filter((todo) => todo.status === "completed").length;
  return completed / todos.length;
}

function todoBlockedCount(todos: TodoItem[]): number {
  return todos.filter((todo) => todo.status === "blocked").length;
}

function TodoProgressPie({ todos }: { todos: TodoItem[] }) {
  const ratio = todoCompletionRatio(todos);
  const percent = Math.round(ratio * 100);
  const blockedCount = todoBlockedCount(todos);
  const dashOffset = TODO_PROGRESS_ICON_CIRCUMFERENCE * (1 - ratio);

  return (
    <span
      className="relative flex size-[18px] shrink-0 items-center justify-center"
      role="img"
      aria-label={`Todo progress ${percent}% complete${blockedCount ? `, ${blockedCount} blocked` : ""}`}
      title={`${percent}% complete${blockedCount ? ` · ${blockedCount} blocked` : ""}`}
    >
      <svg
        width={TODO_PROGRESS_ICON_SIZE}
        height={TODO_PROGRESS_ICON_SIZE}
        viewBox="0 0 18 18"
        className="block shrink-0"
        aria-hidden
      >
        <circle
          cx="9"
          cy="9"
          r={TODO_PROGRESS_ICON_RADIUS}
          fill="none"
          stroke="var(--border-card)"
          strokeWidth={TODO_PROGRESS_ICON_STROKE}
        />
        {ratio > 0 ? (
          <circle
            cx="9"
            cy="9"
            r={TODO_PROGRESS_ICON_RADIUS}
            fill="none"
            stroke="var(--text-secondary)"
            strokeWidth={TODO_PROGRESS_ICON_STROKE}
            strokeLinecap="round"
            strokeDasharray={TODO_PROGRESS_ICON_CIRCUMFERENCE}
            strokeDashoffset={dashOffset}
            transform="rotate(-90 9 9)"
          />
        ) : null}
        {blockedCount > 0 ? (
          <circle
            cx="9"
            cy="9"
            r="2"
            fill="#f59e0b"
          />
        ) : null}
      </svg>
    </span>
  );
}

export function TodoRow({ todo }: { todo: TodoItem }) {
  return (
    <div className="flex items-start gap-[6px]">
      <span className="mt-[1px] shrink-0">
        <TodoIcon status={todo.status} />
      </span>
      <span
        className="font-sans text-[14px] font-normal leading-normal"
        style={{
          color:
            todo.status === "in_progress" ||
            todo.status === "completed" ||
            todo.status === "blocked"
              ? "var(--text-primary)"
              : "var(--text-secondary)",
        }}
      >
        {todo.status === "blocked" ? (
          <span className="mr-[6px] text-[#f59e0b]">Blocked:</span>
        ) : null}
        {todo.text}
      </span>
    </div>
  );
}

function minimizedTodoSummary(todos: TodoItem[], label: string): string {
  const active =
    todos.find((todo) => todo.status === "in_progress") ??
    todos.find((todo) => todo.status === "blocked") ??
    todos.find((todo) => todo.status === "pending");
  if (active) {
    return active.text;
  }
  return label;
}

export function TodoCard({
  label,
  todos,
  meldUserAbove = false,
  embeddedInSticky = false,
}: TodoCardProps) {
  const [minimized, setMinimized] = useState(embeddedInSticky);
  const shellClass = meldUserAbove
    ? "mx-[12px] rounded-b-[var(--radius-card)] rounded-t-none border border-[var(--border-card)] border-t-0 bg-[var(--bg-card)]"
    : "rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)]";

  const header = (
    <div
      className={`flex min-w-0 items-center gap-[6px] transition-[padding] ${transitionSnappy} ${
        embeddedInSticky && minimized ? "pb-0" : "pb-[2px]"
      }`}
    >
      <TodoProgressPie todos={todos} />
      <div className="relative min-h-[20px] min-w-0 flex-1">
        <span
          className={`absolute inset-0 flex min-w-0 items-center truncate font-sans text-[14px] font-normal text-[var(--text-secondary)] transition-[opacity,transform] ${transitionSnappy} ${
            embeddedInSticky && minimized
              ? "z-[1] translate-y-0 opacity-100"
              : embeddedInSticky
                ? "z-0 translate-y-[-3px] opacity-0"
                : "relative z-[1] translate-y-0 opacity-100"
          }`}
          aria-hidden={embeddedInSticky && !minimized}
        >
          {embeddedInSticky && minimized ? minimizedTodoSummary(todos, label) : label}
        </span>
        {embeddedInSticky ? (
          <span
            className={`absolute inset-0 flex min-w-0 items-center truncate font-sans text-[14px] font-normal text-[var(--text-secondary)] transition-[opacity,transform] ${transitionSnappy} ${
              !minimized
                ? "z-[1] translate-y-0 opacity-100"
                : "z-0 translate-y-[3px] opacity-0"
            }`}
            aria-hidden={minimized}
          >
            {label}
          </span>
        ) : null}
      </div>
      {embeddedInSticky ? (
        <button
          type="button"
          onClick={() => setMinimized((value) => !value)}
          className={`flex size-[24px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] outline-none ring-0 transition-colors duration-150 ease-out hover:bg-[var(--accent-bg)] hover:text-[var(--plan-accent)] focus-visible:outline-none focus-visible:ring-0 motion-reduce:transition-none`}
          aria-label={minimized ? "Expand todo list" : "Minimize todo list"}
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
      ) : null}
    </div>
  );

  const body = (
    <div className="flex flex-col gap-[5px]">
      {todos.map((todo) => (
        <TodoRow key={todo.id} todo={todo} />
      ))}
    </div>
  );

  if (embeddedInSticky) {
    return (
      <div className={`${shellClass} overflow-hidden p-[10px]`}>
        {header}
        <CollapsibleHeight open={!minimized}>
          <div className="pt-[5px]">{body}</div>
        </CollapsibleHeight>
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-[5px] ${shellClass} overflow-hidden p-[10px]`}>
      {header}
      {body}
    </div>
  );
}

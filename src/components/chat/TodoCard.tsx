import { ListChecks, LoaderCircle, Circle, Check } from "lucide-react";
import type { TodoItem } from "@/lib/types";

interface TodoCardProps {
  label: string;
  todos: TodoItem[];
}

function TodoIcon({ status }: { status: TodoItem["status"] }) {
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
  return (
    <Circle
      className="size-[18px] shrink-0 text-[var(--text-secondary)]"
      strokeWidth={1.5}
      aria-hidden
    />
  );
}

export function TodoCard({ label, todos }: TodoCardProps) {
  return (
    <div className="flex flex-col gap-[5px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] p-[10px] overflow-hidden">
      <div className="flex items-center gap-[6px]">
        <ListChecks
          className="size-[18px] shrink-0 text-[var(--text-secondary)]"
          strokeWidth={1.5}
          aria-hidden
        />
        <span className="font-sans text-[14px] font-normal text-[var(--text-secondary)]">
          {label}
        </span>
      </div>

      {todos.map((todo) => (
        <div key={todo.id} className="flex items-start gap-[6px]">
          <span className="mt-[1px] shrink-0">
            <TodoIcon status={todo.status} />
          </span>
          <span
            className="font-sans text-[14px] font-normal leading-normal"
            style={{
              color:
                todo.status === "in_progress" || todo.status === "completed"
                  ? "var(--text-primary)"
                  : "var(--text-secondary)",
            }}
          >
            {todo.text}
          </span>
        </div>
      ))}
    </div>
  );
}

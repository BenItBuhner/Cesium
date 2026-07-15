import { TodoRow } from "./TodoCard";
import type { TodoItem } from "@/lib/types";

interface TodoUpdateCardProps {
  todo: TodoItem;
}

export function TodoUpdateCard({ todo }: TodoUpdateCardProps) {
  return (
    <div className="mx-[12px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] p-[10px] overflow-hidden">
      <TodoRow todo={todo} />
    </div>
  );
}

import {
  Bug,
  Flame,
  GitBranch,
  Infinity,
  Layers,
  ListChecks,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";
import type { KnownEditorMode } from "@/lib/types";

/** Icon that represents a chat mode wherever modes are listed (slash menu, mode dropdown). */
export function iconForModeTone(tone: KnownEditorMode): LucideIcon {
  switch (tone) {
    case "plan":
      return ListChecks;
    case "debug":
      return Bug;
    case "ask":
      return MessageSquare;
    case "goal":
      return Flame;
    case "workflow":
      return GitBranch;
    case "orchestration":
      return Layers;
    default:
      return Infinity;
  }
}

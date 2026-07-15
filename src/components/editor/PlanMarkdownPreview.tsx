"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  PlanBuildControls,
  type PlanBuildModelChoice,
} from "@/components/chat/PlanBuildControls";
import type { ModelInfo } from "@/lib/types";

type Block =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "rule" }
  | { type: "bullet"; items: string[] }
  | { type: "ordered"; items: string[] }
  | { type: "checklist"; items: Array<{ checked: boolean; blocked: boolean; text: string }> }
  | { type: "code"; language: string; code: string };

function inline(text: string): ReactNode {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g);
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index} className="rounded-[3px] bg-[var(--bg-card)] px-[4px] py-[1px] font-mono text-[12px] text-[var(--text-primary)]">{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index} className="font-semibold text-[var(--text-primary)]">{part.slice(2, -2)}</strong>;
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      return <a key={index} href={sanitizeHref(link[2] ?? "#")} className="text-[var(--accent)] underline decoration-[var(--accent)]/40 underline-offset-2">{link[1] ?? ""}</a>;
    }
    return <span key={index}>{part}</span>;
  });
}

function sanitizeHref(href: string): string {
  const trimmed = href.trim();
  if (/^(https?:|mailto:|#|\/)/i.test(trimmed)) {
    return trimmed;
  }
  return "#";
}

function parsePlanMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const language = line.slice(3).trim().toLowerCase();
      index += 1;
      const code: string[] = [];
      while (index < lines.length && !lines[index]!.startsWith("```")) {
        code.push(lines[index]!);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language, code: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1]!.length as 1 | 2 | 3, text: heading[2]!.trim() });
      index += 1;
      continue;
    }
    if (/^\s*-{3,}\s*$/.test(line)) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }
    if (/^\s*[-*]\s+\[[ xX!~-]\]\s+/.test(line)) {
      const items: Array<{ checked: boolean; blocked: boolean; text: string }> = [];
      while (index < lines.length) {
        const match = /^\s*[-*]\s+\[([ xX!~-])\]\s+(.+)$/.exec(lines[index]!);
        if (!match) break;
        const marker = match[1]!;
        items.push({
          checked: marker === "x" || marker === "X",
          blocked: marker === "!" || marker === "~" || marker === "-",
          text: match[2]!.trim(),
        });
        index += 1;
      }
      blocks.push({ type: "checklist", items });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const match = /^\s*[-*]\s+(.+)$/.exec(lines[index]!);
        if (!match || /^\s*[-*]\s+\[[ xX!~-]\]\s+/.test(lines[index]!)) break;
        items.push(match[1]!.trim());
        index += 1;
      }
      blocks.push({ type: "bullet", items });
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const match = /^\s*\d+\.\s+(.+)$/.exec(lines[index]!);
        if (!match) break;
        items.push(match[1]!.trim());
        index += 1;
      }
      blocks.push({ type: "ordered", items });
      continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index]!.trim() && !/^(#{1,3})\s+/.test(lines[index]!) && !lines[index]!.startsWith("```") && !/^\s*([-*]|\d+\.)\s+/.test(lines[index]!)) {
      paragraph.push(lines[index]!.trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraph.join(" ") });
  }
  return blocks;
}

function dispatchPlanEvent(type: string, detail: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent(type, { detail }));
}

export function PlanMarkdownPreview({
  source,
  path,
  title,
  models = [],
  currentModel = null,
}: {
  source: string;
  path?: string;
  title?: string;
  models?: ModelInfo[];
  currentModel?: ModelInfo | null;
}) {
  const [modelChoice, setModelChoice] = useState<PlanBuildModelChoice>("inherit");
  const blocks = useMemo(() => parsePlanMarkdown(source), [source]);

  return (
    <div className="hide-scrollbar-y relative h-full min-h-0 overflow-y-auto overscroll-y-contain bg-[var(--bg-main)] px-[9%] py-[28px] [-webkit-overflow-scrolling:touch]">
      <div className="sticky top-[12px] z-20 mx-auto flex max-w-[760px] justify-end">
        <PlanBuildControls
          models={models}
          currentModel={currentModel}
          modelChoice={modelChoice}
          onModelChoiceChange={setModelChoice}
          compact
          onBuild={(request) =>
            dispatchPlanEvent("opencursor:plan-build", {
              path,
              title,
              mode: request.mode,
              modelChoice: request.modelChoice,
            })
          }
        />
      </div>
      <article className="mx-auto max-w-[760px] pb-[80px] font-sans text-[13px] text-[var(--text-primary)]">
        {blocks.map((block, index) => {
          if (block.type === "heading") {
            const Tag = block.level === 1 ? "h1" : block.level === 2 ? "h2" : "h3";
            const className =
              block.level === 1
                ? "mb-[10px] mt-[2px] text-[22px] font-semibold tracking-tight"
                : block.level === 2
                  ? "mb-[8px] mt-[22px] text-[17px] font-semibold"
                  : "mb-[6px] mt-[18px] text-[15px] font-semibold";
            return <Tag key={index} className={className}>{inline(block.text)}</Tag>;
          }
          if (block.type === "paragraph") {
            return <p key={index} className="mb-[12px] leading-relaxed text-[var(--text-secondary)]">{inline(block.text)}</p>;
          }
          if (block.type === "rule") {
            return <hr key={index} className="my-[18px] border-0 border-t border-[var(--border-card)]" />;
          }
          if (block.type === "bullet" || block.type === "ordered") {
            const List = block.type === "bullet" ? "ul" : "ol";
            return (
              <List key={index} className={`mb-[12px] space-y-[5px] ${block.type === "ordered" ? "list-decimal pl-[20px]" : "list-disc pl-[18px]"}`}>
                {block.items.map((item, itemIndex) => <li key={itemIndex} className="leading-relaxed">{inline(item)}</li>)}
              </List>
            );
          }
          if (block.type === "checklist") {
            return (
              <div key={index} className="mb-[14px] space-y-[6px]">
                {block.items.map((item, itemIndex) => (
                  <div key={itemIndex} className="flex items-start gap-[8px] rounded-[6px] border border-[var(--border-subtle)] bg-[var(--bg-card)] px-[9px] py-[7px]">
                    <span className={`mt-[1px] flex size-[14px] shrink-0 items-center justify-center rounded-[3px] border text-[10px] ${item.checked ? "border-[var(--ask-accent)] bg-[var(--ask-accent-bg)] text-[var(--ask-accent)]" : item.blocked ? "border-[var(--plan-accent)] bg-[var(--plan-accent-bg)] text-[var(--plan-accent)]" : "border-[var(--border-card)] text-transparent"}`}>
                      {item.checked ? "x" : item.blocked ? "!" : ""}
                    </span>
                    <span className={item.checked ? "text-[var(--text-secondary)] line-through" : "text-[var(--text-primary)]"}>{inline(item.text)}</span>
                  </div>
                ))}
              </div>
            );
          }
          const isMermaid = block.type === "code" && block.language === "mermaid";
          return (
            <div key={index} className={`mb-[14px] overflow-hidden rounded-[8px] border border-[var(--border-subtle)] ${isMermaid ? "bg-[var(--bg-card)]" : "bg-[var(--bg-panel)]"}`}>
              {isMermaid ? <div className="border-b border-[var(--border-subtle)] px-[10px] py-[6px] font-sans text-[11px] text-[var(--text-secondary)]">Mermaid Diagram</div> : null}
              <pre className="hide-scrollbar-x overflow-x-auto p-[12px] font-mono text-[12px] leading-relaxed text-[var(--text-primary)]">{block.code}</pre>
            </div>
          );
        })}
      </article>
    </div>
  );
}

"use client";

import type { ReactNode } from "react";

type LinkSegment =
  | { kind: "text"; value: string }
  | { kind: "link"; label: string; href: string };

function sanitizeHref(raw: string): string | null {
  const t = raw.trim();
  if (/^https?:\/\//i.test(t)) return t;
  if (/^mailto:/i.test(t)) return t;
  if (t.startsWith("/") || t.startsWith("./") || t.startsWith("../")) return t;
  if (t.startsWith("#")) return t;
  return null;
}

/** Split on [label](url) where label may contain `` `...` `` spans and nested [...] */
function splitMarkdownLinks(source: string): LinkSegment[] {
  const out: LinkSegment[] = [];
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf("[", i);
    if (open === -1) {
      if (i < source.length) out.push({ kind: "text", value: source.slice(i) });
      break;
    }
    if (open > i) out.push({ kind: "text", value: source.slice(i, open) });
    let j = open + 1;
    let depth = 1;
    let labelEnd = -1;
    while (j < source.length) {
      const ch = source[j];
      if (ch === "`") {
        const end = source.indexOf("`", j + 1);
        if (end === -1) {
          labelEnd = -1;
          break;
        }
        j = end + 1;
        continue;
      }
      if (ch === "[") {
        depth++;
        j++;
        continue;
      }
      if (ch === "]") {
        depth--;
        if (depth === 0) {
          labelEnd = j;
          break;
        }
        j++;
        continue;
      }
      j++;
    }
    if (labelEnd < 0 || labelEnd + 1 >= source.length || source[labelEnd + 1] !== "(") {
      out.push({ kind: "text", value: source[open] });
      i = open + 1;
      continue;
    }
    let k = labelEnd + 2;
    let parenDepth = 1;
    let urlEnd = -1;
    while (k < source.length) {
      const ch = source[k];
      if (ch === "(") parenDepth++;
      else if (ch === ")") {
        parenDepth--;
        if (parenDepth === 0) {
          urlEnd = k;
          break;
        }
      }
      k++;
    }
    if (urlEnd < 0) {
      out.push({ kind: "text", value: source[open] });
      i = open + 1;
      continue;
    }
    const label = source.slice(open + 1, labelEnd);
    const href = source.slice(labelEnd + 2, urlEnd);
    out.push({ kind: "link", label, href });
    i = urlEnd + 1;
  }
  return out;
}

function InlineCodeAndBold({ text }: { text: string }): ReactNode {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, idx) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={idx}
          className="rounded-[3px] bg-white/[0.08] px-[4px] py-[1px] font-mono text-[12px] text-[#a5d6a7]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={idx} className="font-semibold text-[var(--text-primary)]">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <span key={idx}>{part}</span>;
  });
}

function Inline({ text }: { text: string }) {
  const segments = splitMarkdownLinks(text);
  return segments.map((seg, idx) => {
    if (seg.kind === "text") {
      return <InlineCodeAndBold key={idx} text={seg.value} />;
    }
    const safe = sanitizeHref(seg.href);
    if (!safe) {
      return <InlineCodeAndBold key={idx} text={`[${seg.label}](${seg.href})`} />;
    }
    const external = /^https?:\/\//i.test(safe);
    return (
      <a
        key={idx}
        href={safe}
        className="text-[#6cb5f5] underline decoration-[#6cb5f5]/40 underline-offset-2 hover:decoration-[#6cb5f5]"
        target={external ? "_blank" : undefined}
        rel={external ? "noopener noreferrer" : undefined}
      >
        <InlineCodeAndBold text={seg.label} />
      </a>
    );
  });
}

function paragraph(text: string, key: number) {
  const t = text.trim();
  if (!t) return null;
  return (
    <p key={key} className="mb-[10px] leading-relaxed text-[var(--text-primary)]">
      <Inline text={t} />
    </p>
  );
}

/** Lightweight markdown for demo README/plan files (no extra deps). */
export function SimpleMarkdownPreview({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      i++;
      const code: string[] = [];
      while (i < lines.length && !lines[i].startsWith("```")) {
        code.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push(
        <pre
          key={key++}
          className="mb-[14px] overflow-x-auto rounded-[6px] border border-[var(--border-subtle)] bg-[#1e1e1e] p-[12px] font-mono text-[12px] leading-relaxed text-[#d4d4d4]"
        >
          {code.join("\n")}
        </pre>
      );
      continue;
    }
    if (line.startsWith("### ")) {
      blocks.push(
        <h3
          key={key++}
          className="mb-[6px] mt-[18px] font-sans text-[15px] font-semibold text-[var(--text-primary)]"
        >
          <Inline text={line.slice(4)} />
        </h3>
      );
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      blocks.push(
        <h2
          key={key++}
          className="mb-[8px] mt-[20px] font-sans text-[17px] font-semibold tracking-tight text-[var(--text-primary)]"
        >
          <Inline text={line.slice(3)} />
        </h2>
      );
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      blocks.push(
        <h1
          key={key++}
          className="mb-[10px] mt-[4px] font-sans text-[22px] font-semibold tracking-tight text-[var(--text-primary)]"
        >
          <Inline text={line.slice(2)} />
        </h1>
      );
      i++;
      continue;
    }
    if (line.startsWith("- ") || line.startsWith("* ")) {
      const items: string[] = [];
      while (i < lines.length && (lines[i].startsWith("- ") || lines[i].startsWith("* "))) {
        items.push(lines[i].slice(2));
        i++;
      }
      blocks.push(
        <ul
          key={key++}
          className="mb-[12px] ml-[4px] list-none space-y-[6px] font-sans text-[13px] text-[var(--text-primary)]"
        >
          {items.map((item, j) => (
            <li key={j} className="flex gap-[8px] leading-relaxed">
              <span className="mt-[6px] size-[4px] shrink-0 rounded-full bg-[var(--text-secondary)]" />
              <span>
                <Inline text={item} />
              </span>
            </li>
          ))}
        </ul>
      );
      continue;
    }
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !lines[i].startsWith("#")) {
      if (lines[i].startsWith("- ") || lines[i].startsWith("* ")) break;
      if (lines[i].startsWith("```")) break;
      para.push(lines[i]);
      i++;
    }
    const p = paragraph(para.join(" "), key++);
    if (p) blocks.push(p);
  }

  return (
    <div className="h-full min-h-0 overflow-auto bg-[var(--bg-main)] px-[10%] py-[24px]">
      <article className="mx-auto max-w-[720px]">{blocks}</article>
    </div>
  );
}

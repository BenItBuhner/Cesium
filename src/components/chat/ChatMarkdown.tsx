"use client";

import { Fragment, memo, useMemo, type ReactNode } from "react";
import { matchArtifactEmbedLine } from "@/lib/artifact-embed";
import { ArtifactCard } from "./ArtifactCard";

type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; language?: string; content: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "hr" }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "blockquote"; lines: string[] }
  | { type: "artifact"; artifactId: string };

function isHorizontalRule(line: string): boolean {
  return /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line);
}

function isTableSeparator(line: string): boolean {
  const normalized = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  if (!normalized.includes("|")) {
    return false;
  }
  return normalized
    .split("|")
    .every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function findNextNonBlankLineIndex(lines: readonly string[], start: number): number {
  for (let i = start; i < lines.length; i += 1) {
    if (lines[i]?.trim()) {
      return i;
    }
  }
  return -1;
}

function listLineMatch(line: string): { marker: string; body: string } | null {
  const m = line.match(/^\s*((?:[-*+])|(?:\d+\.))\s+(.+)$/);
  if (!m) {
    return null;
  }
  return { marker: m[1], body: m[2] };
}

function isIndentedListContinuation(line: string): boolean {
  return /^(?:\t|\s{2,})\S/.test(line);
}

function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const artifactId = matchArtifactEmbedLine(trimmed);
    if (artifactId) {
      blocks.push({ type: "artifact", artifactId });
      index += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const language = line.slice(3).trim() || undefined;
      index += 1;
      const codeLines: string[] = [];
      while (index < lines.length && !lines[index]?.startsWith("```")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push({
        type: "code",
        language,
        content: codeLines.join("\n"),
      });
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        text: headingMatch[2].trim(),
      });
      index += 1;
      continue;
    }

    if (isHorizontalRule(trimmed)) {
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }

    if (
      trimmed.includes("|") &&
      index + 1 < lines.length &&
      isTableSeparator(lines[index + 1] ?? "")
    ) {
      const headers = splitTableRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length) {
        const candidate = lines[index] ?? "";
        const candidateTrimmed = candidate.trim();
        if (!candidateTrimmed || !candidateTrimmed.includes("|")) {
          break;
        }
        rows.push(splitTableRow(candidate));
        index += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? "")) {
        quoteLines.push((lines[index] ?? "").replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "blockquote", lines: quoteLines });
      continue;
    }

    const listMatch = listLineMatch(line);
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch.marker);
      const items: string[] = [listMatch.body];
      index += 1;

      while (index < lines.length) {
        const raw = lines[index] ?? "";
        if (!raw.trim()) {
          const nextIdx = findNextNonBlankLineIndex(lines, index);
          if (nextIdx < 0) {
            break;
          }
          const peek = lines[nextIdx] ?? "";
          const peekMatch = listLineMatch(peek);
          if (peekMatch && /\d+\./.test(peekMatch.marker) === ordered) {
            index = nextIdx;
            items.push(peekMatch.body);
            index += 1;
            continue;
          }
          break;
        }

        const nextItem = listLineMatch(raw);
        if (nextItem && /\d+\./.test(nextItem.marker) === ordered) {
          items.push(nextItem.body);
          index += 1;
          continue;
        }

        if (items.length > 0 && isIndentedListContinuation(raw)) {
          items[items.length - 1] = `${items[items.length - 1]}\n${raw.trimEnd()}`;
          index += 1;
          continue;
        }

        break;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const paragraphLines: string[] = [line];
    index += 1;
    while (index < lines.length) {
      const candidate = lines[index] ?? "";
      const candidateTrimmed = candidate.trim();
      if (!candidateTrimmed) {
        break;
      }
      if (
        candidate.startsWith("```") ||
        candidateTrimmed.match(/^(#{1,6})\s+/) ||
        isHorizontalRule(candidateTrimmed) ||
        /^\s*>\s?/.test(candidate) ||
        /^\s*((?:[-*+])|(?:\d+\.))\s+/.test(candidate) ||
        matchArtifactEmbedLine(candidateTrimmed) !== null
      ) {
        break;
      }
      if (
        candidateTrimmed.includes("|") &&
        index + 1 < lines.length &&
        isTableSeparator(lines[index + 1] ?? "")
      ) {
        break;
      }
      paragraphLines.push(candidate);
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraphLines.join("\n") });
  }

  return blocks;
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern =
    /(\[[^\]]+\]\((?:https?:\/\/|mailto:)[^)]+\)|`[^`]+`|\*\*\*[^*]+?\*\*\*|\*\*[^*]+?\*\*|__[^_]+?__|~~[^~]+?~~|\*[^*\n]+?\*|_[^_\n]+?_)/;
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    const match = remaining.match(pattern);
    if (!match || match.index == null) {
      nodes.push(<Fragment key={key++}>{remaining}</Fragment>);
      break;
    }

    if (match.index > 0) {
      nodes.push(
        <Fragment key={key++}>{remaining.slice(0, match.index)}</Fragment>
      );
    }

    const token = match[0];
    if (token.startsWith("[") && token.includes("](") && token.endsWith(")")) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)]+)\)$/);
      if (linkMatch) {
        nodes.push(
          <a
            key={key++}
            href={linkMatch[2]}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--accent)] underline decoration-[color-mix(in_srgb,var(--accent)_40%,transparent)] underline-offset-[3px]"
          >
            {renderInline(linkMatch[1])}
          </a>
        );
      }
    } else if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(
        <code
          key={key++}
          className="rounded-[5px] border border-[var(--border-card)] bg-[color-mix(in_srgb,var(--bg-card)_82%,black_18%)] px-[5px] py-[1px] font-mono text-[12px] text-[var(--text-primary)]"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (
      (token.startsWith("***") && token.endsWith("***")) ||
      (token.startsWith("___") && token.endsWith("___"))
    ) {
      nodes.push(
        <strong key={key++} className="font-semibold italic text-[var(--text-primary)]">
          {renderInline(token.slice(3, -3))}
        </strong>
      );
    } else if (
      (token.startsWith("**") && token.endsWith("**")) ||
      (token.startsWith("__") && token.endsWith("__"))
    ) {
      nodes.push(
        <strong key={key++} className="font-semibold text-[var(--text-primary)]">
          {renderInline(token.slice(2, -2))}
        </strong>
      );
    } else if (token.startsWith("~~") && token.endsWith("~~")) {
      nodes.push(
        <span key={key++} className="line-through opacity-80">
          {renderInline(token.slice(2, -2))}
        </span>
      );
    } else if (
      (token.startsWith("*") && token.endsWith("*")) ||
      (token.startsWith("_") && token.endsWith("_"))
    ) {
      nodes.push(
        <em key={key++} className="italic text-[var(--text-primary)]">
          {renderInline(token.slice(1, -1))}
        </em>
      );
    } else {
      nodes.push(<Fragment key={key++}>{token}</Fragment>);
    }

    remaining = remaining.slice(match.index + token.length);
  }

  return nodes;
}

function renderInlineWithBreaks(text: string): ReactNode[] {
  const lines = text.split("\n");
  return lines.flatMap((line, index) => {
    const lineNodes = renderInline(line);
    if (index === lines.length - 1) {
      return lineNodes;
    }
    return [...lineNodes, <br key={`br-${index}`} />];
  });
}

function renderHeading(level: 1 | 2 | 3 | 4 | 5 | 6, text: string) {
  const className =
    level === 1
      ? "text-[22px] font-semibold tracking-[-0.02em]"
      : level === 2
        ? "text-[18px] font-semibold tracking-[-0.015em]"
        : level === 3
          ? "text-[16px] font-semibold"
          : "text-[14px] font-semibold";

  const Tag = `h${level}` as const;
  return (
    <Tag className={`mt-[2px] font-sans text-[var(--text-primary)] ${className}`}>
      {renderInline(text)}
    </Tag>
  );
}

/**
 * Value equality for parsed blocks. Parsing recreates every block object on
 * each streaming flush, so the memoized block component compares contents
 * instead of identity - only the block whose text actually changed (almost
 * always the trailing one mid-stream) re-renders its inline nodes and DOM.
 */
function markdownBlocksEqual(a: MarkdownBlock, b: MarkdownBlock): boolean {
  if (a === b) {
    return true;
  }
  if (a.type !== b.type) {
    return false;
  }
  switch (a.type) {
    case "heading":
      return (
        b.type === "heading" && a.level === b.level && a.text === b.text
      );
    case "paragraph":
      return b.type === "paragraph" && a.text === b.text;
    case "code":
      return (
        b.type === "code" && a.language === b.language && a.content === b.content
      );
    case "list":
      return (
        b.type === "list" &&
        a.ordered === b.ordered &&
        a.items.length === b.items.length &&
        a.items.every((item, i) => item === b.items[i])
      );
    case "hr":
      return true;
    case "table":
      return (
        b.type === "table" &&
        a.headers.length === b.headers.length &&
        a.headers.every((h, i) => h === b.headers[i]) &&
        a.rows.length === b.rows.length &&
        a.rows.every(
          (row, i) =>
            row.length === b.rows[i]!.length &&
            row.every((cell, j) => cell === b.rows[i]![j])
        )
      );
    case "blockquote":
      return (
        b.type === "blockquote" &&
        a.lines.length === b.lines.length &&
        a.lines.every((line, i) => line === b.lines[i])
      );
    case "artifact":
      return b.type === "artifact" && a.artifactId === b.artifactId;
    default:
      return false;
  }
}

const MarkdownBlockView = memo(
  function MarkdownBlockView({ block }: { block: MarkdownBlock }) {
    switch (block.type) {
      case "heading":
        return <div>{renderHeading(block.level, block.text)}</div>;
      case "paragraph":
        return (
          <p className="whitespace-normal break-words">
            {renderInlineWithBreaks(block.text)}
          </p>
        );
      case "code":
        return (
          <div className="overflow-hidden rounded-[10px] border border-[var(--border-card)] bg-[color-mix(in_srgb,var(--bg-card)_78%,black_22%)]">
            {block.language ? (
              <div className="border-b border-[var(--border-card)] px-[10px] py-[6px] font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--text-secondary)]">
                {block.language}
              </div>
            ) : null}
            <pre className="overflow-x-auto px-[12px] py-[10px] font-mono text-[12px] leading-[1.65] text-[var(--text-primary)]">
              {block.content}
            </pre>
          </div>
        );
      case "list":
        if (block.ordered) {
          return (
            <ol className="ml-[1.15em] list-outside list-decimal space-y-[4px] pl-[0.4em] marker:text-[var(--text-secondary)]">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex} className="break-words pl-[2px]">
                  {renderInlineWithBreaks(item)}
                </li>
              ))}
            </ol>
          );
        }
        return (
          <ul className="space-y-[6px]">
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex} className="flex items-start gap-[8px]">
                <span className="mt-[10px] size-[4px] shrink-0 rounded-full bg-[var(--text-secondary)]" />
                <span className="min-w-0 flex-1">{renderInlineWithBreaks(item)}</span>
              </li>
            ))}
          </ul>
        );
      case "hr":
        return (
          <div className="border-t border-[color-mix(in_srgb,var(--border-card)_75%,transparent)] pt-[2px]" />
        );
      case "table":
        return (
          <div className="overflow-x-auto rounded-[10px] border border-[var(--border-card)] bg-[color-mix(in_srgb,var(--bg-card)_60%,transparent)]">
            <table className="min-w-full border-collapse text-left text-[13px]">
              <thead>
                <tr className="border-b border-[var(--border-card)] bg-[color-mix(in_srgb,var(--bg-card)_88%,transparent)]">
                  {block.headers.map((header, cellIndex) => (
                    <th
                      key={cellIndex}
                      className="px-[10px] py-[8px] font-semibold text-[var(--text-primary)]"
                    >
                      {renderInline(header)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr
                    key={rowIndex}
                    className="border-t border-[color-mix(in_srgb,var(--border-card)_65%,transparent)]"
                  >
                    {row.map((cell, cellIndex) => (
                      <td
                        key={cellIndex}
                        className="px-[10px] py-[8px] align-top text-[var(--text-secondary)]"
                      >
                        {renderInlineWithBreaks(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "blockquote":
        return (
          <blockquote className="border-l-2 border-[var(--accent)] pl-[12px] text-[var(--text-secondary)]">
            {block.lines.map((line, lineIndex) => (
              <p key={lineIndex}>{renderInlineWithBreaks(line)}</p>
            ))}
          </blockquote>
        );
      case "artifact":
        return <ArtifactCard artifactId={block.artifactId} />;
      default:
        return null;
    }
  },
  (prev, next) => markdownBlocksEqual(prev.block, next.block)
);

export const ChatMarkdown = memo(function ChatMarkdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  // Stable keys for artifact embeds across streaming re-parses: block indexes
  // shift as text streams in, but "nth occurrence of artifact X" does not, so
  // the live iframe never remounts mid-stream.
  const artifactOccurrence = new Map<string, number>();

  return (
    <div className="min-w-0 space-y-[10px] px-[1px] font-sans text-[14px] leading-[1.6] text-[var(--text-primary)]">
      {blocks.map((block, index) => {
        let key: string | number = index;
        if (block.type === "artifact") {
          const occurrence = artifactOccurrence.get(block.artifactId) ?? 0;
          artifactOccurrence.set(block.artifactId, occurrence + 1);
          key = `artifact-${block.artifactId}-${occurrence}`;
        }
        return <MarkdownBlockView key={key} block={block} />;
      })}
    </div>
  );
});

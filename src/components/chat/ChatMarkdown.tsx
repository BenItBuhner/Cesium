"use client";

import { Fragment, type ReactNode } from "react";

type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; language?: string; content: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "hr" }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "blockquote"; lines: string[] };

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

    const listMatch = line.match(/^\s*((?:[-*+])|(?:\d+\.))\s+(.+)$/);
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[1]);
      const items: string[] = [];
      while (index < lines.length) {
        const candidate = lines[index] ?? "";
        const candidateMatch = candidate.match(
          /^\s*((?:[-*+])|(?:\d+\.))\s+(.+)$/
        );
        if (!candidateMatch || /\d+\./.test(candidateMatch[1]) !== ordered) {
          break;
        }
        items.push(candidateMatch[2]);
        index += 1;
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
        /^\s*((?:[-*+])|(?:\d+\.))\s+/.test(candidate)
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
            className="text-[var(--accent-text)] underline decoration-[color-mix(in_srgb,var(--accent-text)_40%,transparent)] underline-offset-[3px]"
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

export function ChatMarkdown({ source }: { source: string }) {
  const blocks = parseMarkdown(source);

  return (
    <div className="min-w-0 space-y-[10px] px-[1px] font-sans text-[14px] leading-[1.6] text-[var(--text-primary)]">
      {blocks.map((block, index) => {
        switch (block.type) {
          case "heading":
            return <div key={index}>{renderHeading(block.level, block.text)}</div>;
          case "paragraph":
            return (
              <p key={index} className="whitespace-normal break-words">
                {renderInlineWithBreaks(block.text)}
              </p>
            );
          case "code":
            return (
              <div
                key={index}
                className="overflow-hidden rounded-[10px] border border-[var(--border-card)] bg-[color-mix(in_srgb,var(--bg-card)_78%,black_22%)]"
              >
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
                <ol
                  key={index}
                  className="ml-[18px] list-none space-y-[4px] counter-reset:[counter_] [&>li]:counter-increment-[counter_] [&>li]:before:content-[counter(counter_)] [&>li]:before:mr-[8px] [&>li]:before:text-[var(--text-secondary)] [&>li]:before:align-middle"
                  style={{ counterReset: 'counter_ -1' }}
                >
                  {block.items.map((item, itemIndex) => (
                    <li key={itemIndex} className="pl-[4px]">
                      {renderInlineWithBreaks(item)}
                    </li>
                  ))}
                </ol>
              );
            }
            return (
              <ul key={index} className="space-y-[6px]">
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
              <div
                key={index}
                className="border-t border-[color-mix(in_srgb,var(--border-card)_75%,transparent)] pt-[2px]"
              />
            );
          case "table":
            return (
              <div
                key={index}
                className="overflow-x-auto rounded-[10px] border border-[var(--border-card)] bg-[color-mix(in_srgb,var(--bg-card)_60%,transparent)]"
              >
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
              <blockquote
                key={index}
                className="border-l-2 border-[var(--accent)] pl-[12px] text-[var(--text-secondary)]"
              >
                {block.lines.map((line, lineIndex) => (
                  <p key={lineIndex}>{renderInlineWithBreaks(line)}</p>
                ))}
              </blockquote>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}

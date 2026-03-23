"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  formatPrompt,
  initialScrollbackLines,
  runCommand,
  SHELL_START_CWD,
  type ShellState,
} from "@/lib/fake-terminal-shell";

interface FakeTerminalProps {
  /** Raw tab buffer from mock data (login banner + prior commands). */
  initialContent: string;
}

export function FakeTerminal({ initialContent }: FakeTerminalProps) {
  const [lines, setLines] = useState<string[]>(() =>
    initialScrollbackLines(initialContent)
  );
  const [shell, setShell] = useState<ShellState>({
    cwd: SHELL_START_CWD,
  });
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLines(initialScrollbackLines(initialContent));
    setShell({ cwd: SHELL_START_CWD });
    setInput("");
  }, [initialContent]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    requestAnimationFrame(scrollToBottom);
  }, [lines, scrollToBottom]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const prompt = formatPrompt(shell.cwd);

  const runLine = useCallback(
    (raw: string) => {
      const cmdLine = raw.trimEnd();
      const echoLine = `${prompt} ${cmdLine}`;
      const { state: next, output } = runCommand(cmdLine, shell);
      setShell(next);

      if (output.kind === "clear") {
        setLines([]);
        return;
      }

      setLines((prev) => [...prev, echoLine, ...output.lines]);
    },
    [shell, prompt]
  );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const cmdLine = input;
    setInput("");
    runLine(cmdLine);
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-[var(--bg-main)] outline-none"
      tabIndex={-1}
      onPointerDown={() => inputRef.current?.focus()}
    >
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto px-3 py-3"
        style={{
          fontFamily:
            "var(--font-geist-mono), 'Geist Mono', monospace, Consolas, 'Courier New', monospace",
        }}
      >
        <div className="whitespace-pre-wrap break-words text-[13px] leading-[1.45] text-[var(--text-primary)]">
          {lines.join("\n")}
          {lines.length > 0 ? "\n" : null}
        </div>
        <form
          onSubmit={onSubmit}
          className="flex min-w-0 items-center gap-[6px] pt-[2px]"
        >
          <label className="sr-only" htmlFor="fake-terminal-input">
            Terminal command
          </label>
          <span
            className="shrink-0 select-none text-[13px] leading-[1.45] text-[var(--ask-accent)]"
            aria-hidden
          >
            {prompt}
          </span>
          <input
            id="fake-terminal-input"
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-[13px] leading-[1.45] text-[var(--text-primary)] outline-none ring-0 focus:ring-0"
          />
        </form>
      </div>
    </div>
  );
}

import type { ChatMessage, ChatTab, ModelInfo } from "./types";

export const chatTabs: ChatTab[] = [
  { id: "planning", title: "Editor split + overflow", active: true },
  { id: "new", title: "New chat" },
];

export const chatMessages: ChatMessage[] = [
  {
    id: "msg-u1",
    type: "user",
    showReplyCue: true,
    content:
      "Wire the split toggle through panel state and keep tab focus targets correct when closing from the overflow menu.",
  },
  {
    id: "msg-ts1",
    type: "todo-status",
    content: "2 of 5 To-dos Completed",
  },
  {
    id: "msg-worked1",
    type: "worked-session",
    workedLabel: "Worked for 1m 52s",
    workedDefaultOpen: false,
    workedEntries: [
      {
        kind: "verbatim",
        text:
          "Read src/components/editor/EditorPanel.tsx (overflow close handlers, split flags).\nRead EditorTabs.tsx (toolbar + split control).\nRead EditorTab.tsx (click routing).\nRead src/lib/types.ts (EditorTab shape).",
      },
      {
        kind: "explore",
        paths: [
          "src/components/editor/EditorPanel.tsx",
          "src/components/editor/EditorTabs.tsx",
          "src/components/editor/EditorTab.tsx",
          "src/lib/types.ts",
        ],
      },
      {
        kind: "reasoning",
        text:
          "Overflow “close others” should mirror the toolbar: derive the target tab set from focusedPaneRef and secondaryTabId, not only activeTabId.",
      },
      {
        kind: "tool",
        title: "Handling click events 4s",
        detail:
          "Normalized pointer targets on overflow menu so the intended pane receives close/split actions.",
      },
      {
        kind: "tool",
        variant: "terminal",
        title: "Verify TypeScript compiles",
        detail: "cd project root · npx tsc --noEmit",
      },
    ],
  },
  {
    id: "msg-as1",
    type: "assistant",
    content:
      "I traced how the split pane and overflow actions flow through EditorPanel. Next I will align close handlers with the focused pane so we never tear down the wrong editor surface.",
  },
  {
    id: "msg-todo1",
    type: "todo",
    todoLabel: "2 of 5 Done",
    todos: [
      {
        id: "td1",
        text: "Trace split + overflow close paths",
        status: "completed",
      },
      {
        id: "td2",
        text: "Patch EditorPanel + EditorTabs handlers",
        status: "completed",
      },
      {
        id: "td3",
        text: "Run tsc and smoke-test split UI",
        status: "in_progress",
      },
      {
        id: "td4",
        text: "Document behavior in demo-refactor.plan.md",
        status: "pending",
      },
      {
        id: "td5",
        text: "Optional: add keyboard shortcut for pane focus",
        status: "pending",
      },
    ],
  },
  {
    id: "msg-as2",
    type: "assistant",
    content:
      "Typecheck is clean. Split toggle and overflow closes now respect which pane was last focused, so the primary editor is not cleared accidentally.",
  },
  {
    id: "msg-sub1",
    type: "subagent",
    subagentTitle: "Regression sweep: editor tabs and file tree icons",
    subagentMeta: "Completed 5 of 5 to-dos",
    subagentComplete: true,
    subagentTranscript: [
      {
        id: "sub-tr-1",
        type: "assistant",
        content:
          "Running a focused regression pass on editor chrome and the file tree after the split-pane changes.",
      },
      {
        id: "sub-tr-2",
        type: "worked-session",
        workedLabel: "Worked for 42s",
        workedDefaultOpen: false,
        workedEntries: [
          {
            kind: "verbatim",
            text: "Read EditorTab.tsx, EditorTabs.tsx, FileTreeItem.tsx, file-type-icons.ts",
          },
          {
            kind: "reasoning",
            text: "Confirm both panes use the same icon mapping and hit targets stay 28×28.",
          },
        ],
      },
      {
        id: "sub-tr-3",
        type: "todo",
        todoLabel: "5 of 5 Done",
        todos: [
          { id: "s1", text: "Icon import paths", status: "completed" },
          { id: "s2", text: "Tab width + truncation", status: "completed" },
          { id: "s3", text: "Split overflow menu", status: "completed" },
          { id: "s4", text: "Tree dimmed folders", status: "completed" },
          { id: "s5", text: "Visual parity vs main", status: "completed" },
        ],
      },
      {
        id: "sub-tr-4",
        type: "assistant",
        content:
          "No regressions found; tree and tab icons match the new shared helper. Handing back to the main agent.",
      },
    ],
  },
  {
    id: "msg-u2",
    type: "user",
    showReplyCue: true,
    content:
      "Stress-test the chat scroller: add a deep follow-up thread with tools and shell so we can confirm the latest user bubble stays pinned while all of this scrolls underneath.",
  },
  {
    id: "msg-ts2",
    type: "todo-status",
    content: "4 of 6 To-dos Completed",
  },
  {
    id: "msg-worked2",
    type: "worked-session",
    workedLabel: "Worked for 3m 08s",
    workedDefaultOpen: false,
    workedEntries: [
      {
        kind: "verbatim",
        text:
          "Read MessageList.tsx (scroll padding + MessageThreadContent wiring).\nRead StickyChatHeader.tsx (sticky height gate, transparent chrome).\nRead ChatPanel.tsx (docked ask partition).\nRead mock-data.ts (chatMessages ordering).",
      },
      {
        kind: "explore",
        paths: [
          "src/components/chat/MessageList.tsx",
          "src/components/chat/StickyChatHeader.tsx",
          "src/components/chat/ChatPanel.tsx",
          "src/lib/mock-data.ts",
        ],
        caption: "Map sticky header + overflow layout",
      },
      {
        kind: "reasoning",
        text:
          "Latest user (+ melded todo-status) must remain the sticky target; earlier user blocks render in normal flow so history can scroll away. Long assistant/tool sections after the second user make the effect obvious.",
      },
      {
        kind: "tool",
        title: "Patch mock transcript 12s",
        detail: "Append msg-u2, msg-ts2, worked blocks, shell, long replies.",
      },
      {
        kind: "tool",
        variant: "terminal",
        title: "Lint chat components",
        detail: "npx eslint src/components/chat --max-warnings 0",
      },
      {
        kind: "tool",
        title: "Snapshot layout metrics",
        detail: "Measured scroll padding pb-[clamp(220px,38vh,340px)] vs dock height.",
      },
    ],
  },
  {
    id: "msg-act-sticky",
    type: "activity-label",
    activityLabel: "Indexing chat layout references",
    activityDetail: "13 symbols across 6 files",
    activityFiles: [
      "MessageThreadContent.tsx",
      "StickyChatHeader.tsx",
      "MessageList.tsx",
      "ChatPanel.tsx",
      "AskQuestionCard.tsx",
      "ChatComposer.tsx",
    ],
    activityDefaultOpen: false,
  },
  {
    id: "msg-as-sticky-1",
    type: "assistant",
    content:
      "I added a second user turn plus a long run of tool cards and shell noise after it. Scroll up: the first user prompt scrolls off. Scroll down through this wall of output: the **latest** user bubble + todo strip should stay glued to the top while everything below it marches through.",
  },
  {
    id: "msg-shell-sticky",
    type: "shell-run",
    shellTitle: "pnpm exec vitest run src/components/chat --reporter=dot",
  },
  {
    id: "msg-as-sticky-2",
    type: "assistant",
    content:
      "If the sticky header ever feels too tall, StickyChatHeader bails out of `position: sticky` when the combined user + meld block exceeds ~320px so giant prompts do not eat the whole viewport. This demo block is intentionally verbose purely to burn vertical space.",
  },
  {
    id: "msg-todo2",
    type: "todo",
    todoLabel: "6 of 6 Done",
    todos: [
      { id: "st1", text: "Second user + melded status row", status: "completed" },
      { id: "st2", text: "Worked session with 3+ tool rows", status: "completed" },
      { id: "st3", text: "Activity label + shell cards", status: "completed" },
      { id: "st4", text: "Long assistant filler paragraphs", status: "completed" },
      { id: "st5", text: "Scroll verify sticky target = msg-u2", status: "completed" },
      { id: "st6", text: "Keep ask-question docked at bottom", status: "completed" },
    ],
  },
  {
    id: "msg-worked3",
    type: "worked-session",
    workedLabel: "Worked for 48s",
    workedDefaultOpen: false,
    workedEntries: [
      {
        kind: "verbatim",
        text: "Re-read findLatestUserStickyTail() — confirms only the trailing user message can be active.",
      },
      {
        kind: "tool",
        title: "Sanity-check React keys",
        detail: "StickyChatHeader keys stable across sticky on/off toggle.",
      },
    ],
  },
  {
    id: "msg-as-sticky-3",
    type: "assistant",
    content:
      "You should still see the docked question card and composer through the transparent bottom stack. Keep scrolling: subagent cards and todos above this paragraph should slide under the pinned user header without the header stealing pointer events from the thread (only the bubble itself is opaque).",
  },
  {
    id: "msg-as-sticky-4",
    type: "assistant",
    content:
      "Extra paragraph one — lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.",
  },
  {
    id: "msg-as-sticky-5",
    type: "assistant",
    content:
      "Extra paragraph two — duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.",
  },
  {
    id: "msg-as3",
    type: "assistant",
    content:
      "If you want, we can add a visible focus ring on the active pane header next so split mode is obvious at a glance.",
  },
  {
    id: "msg-ask1",
    type: "ask-question",
    questionSteps: [
      {
        id: "q1",
        title: "Release scope",
        content:
          "Pick what we lock in for this pass before moving on. You can change your mind with the arrows until you submit the flow.",
        options: [
          { letter: "A", text: "Ship as-is and move on to keyboard shortcuts." },
          { letter: "B", text: "Add the pane focus ring + polish pass first." },
          {
            letter: "C",
            text: "Other",
            isOther: true,
            placeholder: "Describe what to do next…",
          },
        ],
      },
      {
        id: "q2",
        title: "Test coverage",
        content:
          "How deep should validation go for the demo shell? Other is always available if your answer is not listed.",
        options: [
          { letter: "A", text: "Smoke-test split UI only." },
          { letter: "B", text: "Full chat + editor regression pass." },
          { letter: "C", text: "Skip automated tests for this demo." },
        ],
      },
      {
        id: "q3",
        title: "Docs follow-up",
        content:
          "Whether to touch the plan file or leave docs as-is for this iteration.",
        options: [
          { letter: "A", text: "Update demo-refactor.plan.md." },
          { letter: "B", text: "No doc changes." },
        ],
      },
      {
        id: "q4",
        title: "Priority after merge",
        content:
          "What should we tackle first once this branch lands? Use Other for anything not covered.",
        options: [
          { letter: "A", text: "Keyboard shortcuts for pane focus." },
          { letter: "B", text: "Theming / density pass." },
          {
            letter: "C",
            text: "Other",
            isOther: true,
            placeholder: "Next priority…",
          },
        ],
      },
      {
        id: "q5",
        title: "Notify",
        content:
          "Let us know if you want a ping when this thread is ready to close.",
        options: [
          { letter: "A", text: "Ping when this thread is ready to close." },
          { letter: "B", text: "No notification needed." },
        ],
      },
    ],
  },
];

export const availableModels: ModelInfo[] = [
  { id: "composer-2-fast", name: "Composer 2 Fast", provider: "auto", selected: true },
  { id: "gpt-5.4-fast", name: "GPT-5.4 Fast", provider: "openai" },
  { id: "gpt-5.4-extra-high-fast", name: "GPT-5.4 Extra High Fast", provider: "openai" },
  { id: "opus-4.6-max", name: "Opus 4.6 Max", provider: "anthropic" },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", provider: "openai" },
  { id: "gpt-5.4-mini-extra-high", name: "GPT-5.4 Mini Extra High", provider: "openai" },
  { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark", provider: "openai" },
];

export const currentModel: ModelInfo = availableModels[0];

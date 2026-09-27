import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyProjectPageSearch,
  buildProjectContextTree,
  collectProjectMessageCalls,
  matchProjectContextEmbedLine,
  parseProjectContextHref,
  parseProjectNotes,
  parseProjectPageSearch,
  projectAgentEventsToChatMessages,
  projectContextPreviewKind,
  projectCoordinatorMessages,
  projectNoticeDetail,
  projectPullRequestCiBadge,
  projectPullRequestMergeBlocker,
  projectPullRequestReviewBadge,
  projectPullRequestStateBadge,
  projectRelativeTime,
  projectSubscriptionMeta,
  summarizeProjectNotes,
  type AgentStoredEvent,
  type ProjectContextFile,
  type ProjectContextTreeNode,
  type ProjectSubscriptionSummary,
} from "@cesium/core";

test("the Project page lives at ?view=project&project=<id>&tab=<tab>", () => {
  const params = new URLSearchParams("view=project&project=prj_0123456789ab&tab=prs&keep=1");
  assert.deepEqual(parseProjectPageSearch(params), { projectId: "prj_0123456789ab", tab: "prs" });
  assert.deepEqual(parseProjectPageSearch(new URLSearchParams("view=project&project=prj_0123456789ab&tab=nope")), {
    projectId: "prj_0123456789ab",
    tab: "agents",
  });
  assert.equal(parseProjectPageSearch(new URLSearchParams("view=project&project=../etc")), null);
  assert.equal(parseProjectPageSearch(new URLSearchParams("view=settings&project=prj_0123456789ab")), null);

  applyProjectPageSearch(params, { projectId: "prj_ba9876543210", tab: "context" });
  assert.equal(params.toString(), "view=project&project=prj_ba9876543210&tab=context&keep=1");
  applyProjectPageSearch(params, null);
  assert.equal(params.toString(), "keep=1");
  const settings = new URLSearchParams("view=settings");
  applyProjectPageSearch(settings, null);
  assert.equal(settings.toString(), "view=settings", "other views are left alone");
});

test("pull request badges and the merge button follow the engine's merge rules", () => {
  const pr = {
    state: "open" as const,
    draft: false,
    ci: "success" as const,
    failedChecks: [] as string[],
    review: "approved" as const,
    mergeable: true,
  };
  assert.deepEqual(projectPullRequestStateBadge(pr), { label: "Open", tone: "success" });
  assert.deepEqual(projectPullRequestStateBadge({ ...pr, draft: true }), { label: "Draft", tone: "neutral" });
  assert.deepEqual(projectPullRequestStateBadge({ ...pr, state: "merged" }), { label: "Merged", tone: "accent" });
  assert.deepEqual(projectPullRequestCiBadge(pr), { label: "CI passed", tone: "success" });
  assert.deepEqual(projectPullRequestCiBadge({ ci: "failure", failedChecks: ["test", "lint"] }), {
    label: "CI failed: test +1",
    tone: "error",
  });
  assert.equal(projectPullRequestCiBadge({ ci: null, failedChecks: [] }), null);
  assert.deepEqual(projectPullRequestReviewBadge({ review: "changes_requested" }), {
    label: "Changes requested",
    tone: "error",
  });
  assert.equal(projectPullRequestMergeBlocker(pr), null);
  assert.equal(projectPullRequestMergeBlocker({ ...pr, ci: null }), null, "no CI is fine");
  assert.equal(projectPullRequestMergeBlocker({ ...pr, ci: "pending" }), "CI is still running");
  assert.equal(projectPullRequestMergeBlocker({ ...pr, review: "changes_requested" }), "Changes were requested");
  assert.equal(projectPullRequestMergeBlocker({ ...pr, mergeable: false }), "Has merge conflicts");
  assert.equal(projectPullRequestMergeBlocker({ ...pr, draft: true }), "Still a draft");
  assert.equal(projectPullRequestMergeBlocker({ ...pr, state: "merged" }), "Already merged");
});

test("Listening entries say what they watch, for whom and when they fire next", () => {
  const now = Date.UTC(2026, 8, 27, 12);
  assert.equal(projectRelativeTime(now + 5 * 60_000, now), "in 5 min");
  assert.equal(projectRelativeTime(now - 3 * 3_600_000, now), "3 h ago");
  assert.equal(projectRelativeTime(now - 10_000, now), "just now");
  assert.equal(projectRelativeTime(now + 3 * 86_400_000, now), "in 3 d");
  const base: ProjectSubscriptionSummary = {
    id: "sub_1",
    kind: "github_pr",
    label: "acme/shop#12",
    detail: null,
    createdBy: "auto",
    agent: "cart-total",
    createdAt: now,
    expiresAt: now + 86_400_000,
    nextFireAt: null,
    lastEventAt: now - 120_000,
    closedAt: null,
    closedReason: null,
  };
  assert.equal(projectSubscriptionMeta(base, now), "Pull request · cart-total · last event 2 min ago");
  assert.equal(
    projectSubscriptionMeta(
      { ...base, kind: "timer", agent: null, createdBy: "coordinator", nextFireAt: now + 3_600_000, lastEventAt: null },
      now
    ),
    "Timer · next in 1 h · added by the coordinator"
  );
});

test("the Context tree puts notes.md and the standard folders first", () => {
  const file = (path: string): ProjectContextFile => ({ path, size: 1, updatedAt: 0, kind: "text" });
  const tree = buildProjectContextTree(
    [file("zeta.txt"), file("media/cart/after.png"), file("docs/plan.md"), file("notes.md"), file("docs/a/b.md"), file("docs/10.md"), file("docs/9.md")],
    ["internal", "inbox", "media/cart"]
  );
  const names = (nodes: ProjectContextTreeNode[]) => nodes.map((node) => `${node.type === "folder" ? "/" : ""}${node.name}`);
  assert.deepEqual(names(tree), ["notes.md", "/docs", "/internal", "/media", "/inbox", "zeta.txt"]);
  const docs = tree[1] as Extract<ProjectContextTreeNode, { type: "folder" }>;
  assert.deepEqual(names(docs.children), ["/a", "9.md", "10.md", "plan.md"], "folders first, numbers in order");
  const media = tree[3] as Extract<ProjectContextTreeNode, { type: "folder" }>;
  assert.equal(media.children[0]?.path, "media/cart");
  assert.equal(projectContextPreviewKind("docs/plan.md"), "markdown");
  assert.equal(projectContextPreviewKind("media/a.PNG"), "image");
  assert.equal(projectContextPreviewKind("media/demo.webm"), "video");
  assert.equal(projectContextPreviewKind("inbox/x.json"), "text");
  assert.equal(projectContextPreviewKind("blob.bin"), "binary");
  assert.equal(projectContextPreviewKind("mystery", "text"), "text");
});

test("context: references only reach inside the Project context", () => {
  assert.equal(parseProjectContextHref("context:media/cart/after.png"), "media/cart/after.png");
  assert.equal(parseProjectContextHref("context:media/my%20shot.png#x"), "media/my shot.png");
  assert.equal(parseProjectContextHref("context:./docs/plan.md"), "docs/plan.md");
  for (const bad of ["context:../secrets", "context:/etc/passwd", "context:media//x", "context:", "https://x/y.png", "context:a\\b"]) {
    assert.equal(parseProjectContextHref(bad), null, bad);
  }
  assert.deepEqual(matchProjectContextEmbedLine("![after the fix](context:media/cart/after.png)"), {
    path: "media/cart/after.png",
    label: "after the fix",
    kind: "image",
  });
  assert.deepEqual(matchProjectContextEmbedLine("  [demo video](context:media/cart/demo.mp4) "), {
    path: "media/cart/demo.mp4",
    label: "demo video",
    kind: "video",
  });
  assert.deepEqual(matchProjectContextEmbedLine("[](context:docs/plan.md)"), { path: "docs/plan.md", label: "plan.md", kind: "file" });
  assert.equal(matchProjectContextEmbedLine("See ![x](context:media/a.png) inline"), null, "only whole lines embed");
  assert.equal(matchProjectContextEmbedLine("![x](context:media/a.png"), null, "half-streamed stays text");
});

test("notes.md reads as a checklist", () => {
  const notes = [
    "# Checkout revamp",
    "",
    "- [x] Explore the cart (explore)",
    "- [ ] Fix the total (cart-total, acme/shop#1)",
    "  - [ ] Tests (cart-tests)",
    "- Decisions in docs/decisions.md",
    "```",
    "- [ ] not a task",
    "```",
    "Waiting on CI.",
  ].join("\n");
  assert.deepEqual(parseProjectNotes(notes), [
    { kind: "heading", text: "Checkout revamp" },
    { kind: "task", text: "Explore the cart (explore)", done: true, depth: 0 },
    { kind: "task", text: "Fix the total (cart-total, acme/shop#1)", done: false, depth: 0 },
    { kind: "task", text: "Tests (cart-tests)", done: false, depth: 1 },
    { kind: "bullet", text: "Decisions in docs/decisions.md", depth: 0 },
    { kind: "text", text: "Waiting on CI." },
  ]);
  assert.deepEqual(summarizeProjectNotes(notes), { done: 1, total: 3 });
  assert.deepEqual(summarizeProjectNotes(""), { done: 0, total: 0 });
});

let seq = 0;
function event(input: Record<string, unknown>): AgentStoredEvent {
  seq += 1;
  return {
    seq,
    eventId: `e${seq}`,
    conversationId: "c1",
    createdAt: 1_700_000_000_000 + seq * 1_000,
    ...input,
  } as AgentStoredEvent;
}

function toolCall(id: string, name: string, args: Record<string, unknown>, title: string, status = "completed") {
  return [
    event({
      kind: "tool_call",
      toolCallId: id,
      title,
      toolKind: "orchestration",
      status: "in_progress",
      detail: JSON.stringify(args),
      raw: { id, name, arguments: args },
    }),
    event({ kind: "tool_call_update", toolCallId: id, status, detail: "{\"ok\":true}" }),
  ];
}

function reply(messageId: string, text: string) {
  return [
    event({ kind: "assistant_message_chunk", messageId, text }),
    event({ kind: "assistant_message_end", messageId }),
    event({ kind: "status", status: "idle" }),
  ];
}

test("the coordinator's chat: messages as bubbles, updates as rows, its own text as a status line", () => {
  const notice = [
    "<project_agent_updates>",
    "Automatic update from your Project agents.",
    '<agent name="cart-total" event="finished" status="idle">',
    "Total now multiplies by quantity.",
    "</agent>",
    "</project_agent_updates>",
  ].join("\n");
  const events: AgentStoredEvent[] = [
    event({ kind: "user_message", messageId: "u1", content: "Checkout totals look wrong. Make it right." }),
    ...toolCall("t1", "project_explore", { repo: "shop", questions: ["Where is the total?"] }, "Explore shop"),
    ...toolCall("t2", "project_message_user", { message: "Starting **cart-total** now." }, "Message"),
    ...toolCall("t3", "project_create_agent", { name: "cart-total", instructions: "Fix it." }, "Create agent cart-total"),
    ...toolCall("t4", "project_message_user", { message: "   " }, "Message", "failed"),
    ...reply("a1", "Explored, started cart-total, told the user."),
    event({ kind: "user_message", messageId: "u2", content: notice, displayContent: "Agent update · cart-total" }),
    ...reply("a2", "Noted in notes.md."),
    event({ kind: "user_message", messageId: "u3", content: "What's running?" }),
    ...reply("a3", "cart-total is working on the total."),
  ];
  const calls = collectProjectMessageCalls(events);
  assert.deepEqual([...calls.keys()], ["t2"], "empty or failed messages are not bubbles");

  const projected = projectAgentEventsToChatMessages(events, { backendId: "cesium-agent" });
  const shaped = projectCoordinatorMessages(projected, events).map((message) => ({
    type: message.type,
    text:
      message.type === "worked-session"
        ? (message.workedEntries ?? []).map((entry) => (entry.kind === "tool" ? entry.toolCallId : entry.kind)).join(",")
        : message.type === "activity-label"
          ? message.activityLabel
          : message.content,
    ...(message.type === "activity-label" && message.activityDetail ? { detail: message.activityDetail } : {}),
  }));
  assert.deepEqual(
    shaped.filter((entry) => entry.type !== "turn-footer"),
    [
      { type: "user", text: "Checkout totals look wrong. Make it right." },
      { type: "worked-session", text: "t1" },
      { type: "assistant", text: "Starting **cart-total** now." },
      { type: "worked-session", text: "t3,t4" },
      { type: "activity-label", text: "Explored, started cart-total, told the user." },
      {
        type: "activity-label",
        text: "Agent update · cart-total",
        detail: "cart-total · finished\nTotal now multiplies by quantity.",
      },
      { type: "activity-label", text: "Noted in notes.md." },
      { type: "user", text: "What's running?" },
      { type: "assistant", text: "cart-total is working on the total." },
    ]
  );
  const footers = shaped.filter((entry) => entry.type === "turn-footer").length;
  assert.ok(footers <= 2, "update turns get no footer");
});

test("event turns read as rows naming each event", () => {
  const raw = [
    "<project_events>",
    '<system_notification source="github" kind="ci" repo="acme/shop" pr="12" agent="cart-total">',
    "CI failed: test (&lt;script&gt; in the log)",
    "</system_notification>",
    "</project_events>",
    "These notifications come from the Project's subscriptions.",
  ].join("\n");
  assert.equal(
    projectNoticeDetail(raw),
    "github · kind ci · repo acme/shop · pr 12 · agent cart-total\nCI failed: test (<script> in the log)"
  );
  assert.equal(projectNoticeDetail("plain text"), "plain text");
});

import assert from "node:assert/strict";
import test from "node:test";
import { resolveAgentRightPaneOpen } from "../src/lib/agent-right-pane";

test("draft selection stays collapsed until explicitly opened", () => {
  assert.equal(
    resolveAgentRightPaneOpen({
      isDraftConversationSelected: true,
      persistedRightPaneOpen: true,
      draftRightPaneExplicitlyOpen: false,
    }),
    false
  );
  assert.equal(
    resolveAgentRightPaneOpen({
      isDraftConversationSelected: true,
      persistedRightPaneOpen: false,
      draftRightPaneExplicitlyOpen: true,
    }),
    true
  );
});

test("conversation selection follows its persisted pane state", () => {
  assert.equal(
    resolveAgentRightPaneOpen({
      isDraftConversationSelected: false,
      persistedRightPaneOpen: true,
      draftRightPaneExplicitlyOpen: false,
    }),
    true
  );
  assert.equal(
    resolveAgentRightPaneOpen({
      isDraftConversationSelected: false,
      persistedRightPaneOpen: false,
      draftRightPaneExplicitlyOpen: true,
    }),
    false
  );
});

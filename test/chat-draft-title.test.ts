import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  countComposerUploads,
  formatProvisionalChatTitle,
  formatProvisionalChatTitleFromComposer,
  landingDraftUsesStandaloneWorkspace,
  resolveGeneratedOrFallbackTitle,
  resolveLandingComposerDraftId,
  shouldReplaceConversationTitleOnFirstPrompt,
  truncateProvisionalTitle,
} from "../packages/core/src/chat-draft-title.ts";

describe("provisional chat titles", () => {
  test("uses the first characters of the user message", () => {
    assert.equal(
      formatProvisionalChatTitle({ text: "  Fix the login redirect\nplease  " }),
      "Fix the login redirect please"
    );
  });

  test("truncates long messages with an ellipsis", () => {
    const title = truncateProvisionalTitle("x".repeat(80), 72);
    assert.equal(title.length, 72);
    assert.equal(title.endsWith("…"), true);
  });

  test("names attachment-only drafts by upload count", () => {
    assert.equal(formatProvisionalChatTitle({ text: "   ", attachmentCount: 1 }), "1 upload");
    assert.equal(formatProvisionalChatTitle({ text: "", attachmentCount: 3 }), "3 uploads");
    assert.equal(formatProvisionalChatTitle({ text: "", attachmentCount: 0 }), "Untitled");
  });

  test("counts attachments before captures and references", () => {
    assert.equal(
      countComposerUploads({
        attachments: [{}, {}],
        captures: { a: {} },
        textReferences: { t: {} },
      }),
      2
    );
    assert.equal(
      countComposerUploads({
        captures: { a: {}, b: {} },
        textReferences: { t: {} },
      }),
      2
    );
    assert.equal(
      countComposerUploads({
        textReferences: { t: {} },
        linkReferences: { l: {}, m: {} },
      }),
      3
    );
  });

  test("builds a title from composer contents", () => {
    assert.equal(
      formatProvisionalChatTitleFromComposer({
        content: "",
        attachments: [{}, {}, {}],
      }),
      "3 uploads"
    );
  });
});

describe("first-prompt title replacement", () => {
  test("prefers a generated title and falls back to first characters", () => {
    assert.equal(resolveGeneratedOrFallbackTitle("Login redirect", "Fix the login"), "Login redirect");
    assert.equal(resolveGeneratedOrFallbackTitle(null, "Fix the login"), "Fix the login");
    assert.equal(resolveGeneratedOrFallbackTitle("   ", "1 upload"), "1 upload");
  });

  test("replaces placeholders, draft prefixes, and the persisted provisional title", () => {
    assert.equal(shouldReplaceConversationTitleOnFirstPrompt("New chat"), true);
    assert.equal(shouldReplaceConversationTitleOnFirstPrompt("Draft: Hello"), true);
    assert.equal(
      shouldReplaceConversationTitleOnFirstPrompt("Fix the login", "Fix the login"),
      true
    );
    assert.equal(
      shouldReplaceConversationTitleOnFirstPrompt("My custom name", "Fix the login"),
      false
    );
  });
});

describe("landing composer draft ids", () => {
  test("uses the standalone id for no-workspace drafts", () => {
    assert.equal(
      resolveLandingComposerDraftId({
        standaloneDraftActive: true,
        activeWorkspaceId: "ws-1",
        activeIsStandaloneChat: false,
      }),
      "agent-draft:standalone"
    );
    assert.equal(
      resolveLandingComposerDraftId({
        standaloneDraftActive: false,
        activeWorkspaceId: null,
        activeIsStandaloneChat: false,
      }),
      "agent-draft:standalone"
    );
  });

  test("uses the workspace id for project new-chat drafts", () => {
    assert.equal(
      resolveLandingComposerDraftId({
        standaloneDraftActive: false,
        activeWorkspaceId: "ws-abc",
        activeIsStandaloneChat: false,
      }),
      "agent-draft:ws-abc"
    );
  });

  test("reuses an existing standalone workspace instead of creating another", () => {
    assert.equal(
      landingDraftUsesStandaloneWorkspace({
        standaloneDraftActive: false,
        activeWorkspaceId: "chat-ws",
        activeIsStandaloneChat: true,
      }),
      false
    );
    assert.equal(
      landingDraftUsesStandaloneWorkspace({
        standaloneDraftActive: true,
        activeWorkspaceId: "ws-1",
        activeIsStandaloneChat: false,
      }),
      true
    );
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  AGENT_STANDALONE_COMPOSER_DRAFT_ID,
  agentWorkspaceComposerDraftId,
  mergeComposerDraftRecord,
  type ComposerDraftRecord,
} from "../src/components/editor/OpenInEditorContext.tsx";

describe("mergeComposerDraftRecord", () => {
  test("omitting content preserves a cleared empty draft (submit race regression)", () => {
    const cleared: ComposerDraftRecord = {
      draftId: "agent-draft:workspace",
      title: "Agent prompt",
      content: "",
    };
    // ChatComposer clears text via onValueChange(""), then clears attachments.
    // Parents must not re-pass a stale content closure when patching attachments.
    const afterAttachments = mergeComposerDraftRecord(cleared, cleared.draftId, {
      title: cleared.title,
      attachments: [],
    });
    assert.equal(afterAttachments.content, "");
    assert.deepEqual(afterAttachments.attachments, []);
  });

  test("stale content in an attachments patch would resurrect the prompt", () => {
    const cleared: ComposerDraftRecord = {
      draftId: "conv-1",
      title: "Agent prompt",
      content: "",
    };
    const resurrected = mergeComposerDraftRecord(cleared, cleared.draftId, {
      title: cleared.title,
      content: "What tools do you have when it comes to accessing and controlling my phone?",
      attachments: [],
    });
    assert.equal(
      resurrected.content,
      "What tools do you have when it comes to accessing and controlling my phone?"
    );
  });

  test("landing draft ids are stable per workspace / standalone", () => {
    assert.equal(AGENT_STANDALONE_COMPOSER_DRAFT_ID, "agent-draft:standalone");
    assert.equal(agentWorkspaceComposerDraftId("ws-abc"), "agent-draft:ws-abc");
    assert.equal(agentWorkspaceComposerDraftId(null), "agent-draft:workspace");
  });
});

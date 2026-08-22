import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  COMPOSER_REPORT_HISTORY_LIMIT,
  COMPOSER_REPORT_MAX_AGE_MS,
  recordComposerDomReport,
  shouldDeferComposerReconcile,
  type ComposerDomReport,
} from "../src/components/chat/composer-editor-utils.ts";

const T0 = 1_000_000;

function history(...texts: string[]): ComposerDomReport[] {
  return texts.map((text, i) => ({ text, at: T0 + i }));
}

describe("recordComposerDomReport", () => {
  test("appends reports and dedupes consecutive duplicates", () => {
    const reports: ComposerDomReport[] = [];
    recordComposerDomReport(reports, "a", T0);
    recordComposerDomReport(reports, "ab", T0 + 1);
    recordComposerDomReport(reports, "ab", T0 + 2); // selectionchange re-report
    recordComposerDomReport(reports, "abc", T0 + 3);
    assert.deepEqual(reports.map((r) => r.text), ["a", "ab", "abc"]);
    // The duplicate refreshed the timestamp instead of adding an entry.
    assert.equal(reports[1]!.at, T0 + 2);
  });

  test("caps the history at the configured limit", () => {
    const reports: ComposerDomReport[] = [];
    for (let i = 0; i < COMPOSER_REPORT_HISTORY_LIMIT + 25; i += 1) {
      recordComposerDomReport(reports, `text-${i}`, T0 + i);
    }
    assert.equal(reports.length, COMPOSER_REPORT_HISTORY_LIMIT);
    assert.equal(reports[0]!.text, "text-25");
  });
});

describe("shouldDeferComposerReconcile", () => {
  test("defers a stale echo so newer keystrokes in the DOM survive", () => {
    // Android fast-typing race: user typed "ab"; the DOM already holds it, but
    // the reconcile effect flushes with the echo of the earlier "a" report.
    assert.equal(
      shouldDeferComposerReconcile({
        value: "a",
        domText: "ab",
        isComposing: false,
        reportHistory: history("a", "ab"),
        now: T0 + 10,
      }),
      true
    );
  });

  test("defers echoes that lag multiple keystrokes behind", () => {
    const reports = history("t", "ty", "typ", "typi");
    for (const stale of ["t", "ty", "typ"]) {
      assert.equal(
        shouldDeferComposerReconcile({
          value: stale,
          domText: "typi",
          isComposing: false,
          reportHistory: reports,
          now: T0 + 10,
        }),
        true,
        `echo ${JSON.stringify(stale)} must defer`
      );
    }
  });

  test("defers the same echo arriving repeatedly from different state paths", () => {
    // Draft stores can echo one report several times (immediate parent state
    // plus a slower persistence round-trip). Entries are not consumed, so the
    // second arrival of "t" is still recognized as an echo.
    const reports = history("t", "ty");
    for (let i = 0; i < 3; i += 1) {
      assert.equal(
        shouldDeferComposerReconcile({
          value: "t",
          domText: "ty",
          isComposing: false,
          reportHistory: reports,
          now: T0 + 10 + i,
        }),
        true
      );
    }
  });

  test("reconciles genuine external changes", () => {
    // Draft switch / history recall: the incoming value was never reported
    // from this DOM, so the DOM must be rebuilt even though the user typed.
    assert.equal(
      shouldDeferComposerReconcile({
        value: "restored older draft",
        domText: "ab",
        isComposing: false,
        reportHistory: history("a", "ab"),
        now: T0 + 10,
      }),
      false
    );
  });

  test("reports age out and regain external-change semantics", () => {
    const reports = history("hi");
    assert.equal(
      shouldDeferComposerReconcile({
        value: "hi",
        domText: "something else",
        isComposing: false,
        reportHistory: reports,
        now: T0 + COMPOSER_REPORT_MAX_AGE_MS + 1000,
      }),
      false
    );
  });

  test("never rebuilds the DOM during IME composition", () => {
    // Even a genuine external change waits until compositionend.
    assert.equal(
      shouldDeferComposerReconcile({
        value: "external",
        domText: "typing with ime",
        isComposing: true,
        reportHistory: [],
        now: T0,
      }),
      true
    );
  });

  test("allows pill-only rebuilds when the text is already in sync", () => {
    // composerEditorDomInSync can fail on pill metadata (link title resolved)
    // while the plain text matches; that rebuild is safe and must proceed.
    assert.equal(
      shouldDeferComposerReconcile({
        value: "see \u27E6link:abc\u27E7",
        domText: "see \u27E6link:abc\u27E7",
        isComposing: false,
        reportHistory: history("see \u27E6link:abc\u27E7"),
        now: T0 + 10,
      }),
      false
    );
  });

  test("post-submit clear defers a late echo of the submitted prompt", () => {
    // submitComposer wipes the DOM to "" and records "" as the newest report.
    // A parent that re-applies the stale prompt afterwards must not resurrect
    // it in the editor.
    const reports: ComposerDomReport[] = [];
    recordComposerDomReport(reports, "deploy the fix", T0);
    recordComposerDomReport(reports, "", T0 + 1);
    assert.equal(
      shouldDeferComposerReconcile({
        value: "deploy the fix",
        domText: "",
        isComposing: false,
        reportHistory: reports,
        now: T0 + 10,
      }),
      true
    );
  });
});

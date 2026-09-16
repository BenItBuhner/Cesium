import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  copyTextToClipboard,
  describeCopyFailure,
} from "../src/lib/copy-to-clipboard.ts";

type FakeTextarea = {
  value: string;
  tabIndex: number;
  attributes: Record<string, string>;
  style: Record<string, string>;
  focused: boolean;
  selected: boolean;
  selectionRange: [number, number] | null;
  removed: boolean;
  setAttribute: (name: string, value: string) => void;
  focus: () => void;
  select: () => void;
  setSelectionRange: (start: number, end: number) => void;
  remove: () => void;
};

type FakeRange = { contents: unknown; selectNodeContents: (node: unknown) => void };

function createFakeDocument(options: {
  execCommand?: (command: string) => boolean;
  withBody?: boolean;
  withSelection?: boolean;
}) {
  const appended: unknown[] = [];
  const textareas: FakeTextarea[] = [];
  const execCalls: string[] = [];
  const focusOrder: string[] = [];
  const activeElement = {
    focus: () => {
      focusOrder.push("previous");
    },
  };
  const selection = {
    ranges: [] as FakeRange[],
    removeAllRanges() {
      this.ranges = [];
    },
    addRange(range: FakeRange) {
      this.ranges.push(range);
    },
  };
  const doc = {
    activeElement,
    body:
      options.withBody === false
        ? null
        : {
            appendChild(node: unknown) {
              appended.push(node);
            },
          },
    createElement(tag: string): FakeTextarea {
      assert.equal(tag, "textarea");
      const textarea: FakeTextarea = {
        value: "",
        tabIndex: 0,
        attributes: {},
        style: {},
        focused: false,
        selected: false,
        selectionRange: null,
        removed: false,
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
        focus() {
          this.focused = true;
          focusOrder.push("textarea");
        },
        select() {
          this.selected = true;
        },
        setSelectionRange(start, end) {
          this.selectionRange = [start, end];
        },
        remove() {
          this.removed = true;
        },
      };
      textareas.push(textarea);
      return textarea;
    },
    execCommand(command: string): boolean {
      execCalls.push(command);
      return options.execCommand ? options.execCommand(command) : false;
    },
    createRange(): FakeRange {
      return {
        contents: null,
        selectNodeContents(node) {
          this.contents = node;
        },
      };
    },
    getSelection: options.withSelection === false ? undefined : () => selection,
  };
  return { doc, appended, textareas, execCalls, focusOrder, selection };
}

/**
 * Installs fake `navigator` / `document` globals for one test. Node ships a
 * real (configurable) `navigator` getter, so restore the original descriptor
 * afterwards instead of deleting it.
 */
async function withBrowserGlobals(
  globals: { navigator: unknown; document: unknown },
  run: () => Promise<void>
): Promise<void> {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const install = (name: "navigator" | "document", value: unknown) => {
    if (value === undefined) {
      delete (globalThis as Record<string, unknown>)[name];
      return;
    }
    Object.defineProperty(globalThis, name, {
      value,
      configurable: true,
      writable: true,
    });
  };
  install("navigator", globals.navigator);
  install("document", globals.document);
  try {
    await run();
  } finally {
    for (const [name, descriptor] of [
      ["navigator", previousNavigator],
      ["document", previousDocument],
    ] as const) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[name];
      }
    }
  }
}

describe("copyTextToClipboard", () => {
  test("uses the Clipboard API and starts the write synchronously inside the gesture", async () => {
    const writes: string[] = [];
    let startedSynchronously = false;
    const fakeDocument = createFakeDocument({ execCommand: () => true });
    await withBrowserGlobals(
      {
        navigator: {
          clipboard: {
            writeText: (text: string) => {
              writes.push(text);
              startedSynchronously = true;
              return Promise.resolve();
            },
          },
        },
        document: fakeDocument.doc,
      },
      async () => {
        const pending = copyTextToClipboard("curl -fsSL https://example.test | bash");
        // No await happened before writeText: the call is already recorded.
        assert.equal(startedSynchronously, true);
        assert.deepEqual(await pending, { ok: true, method: "clipboard-api" });
        assert.deepEqual(writes, ["curl -fsSL https://example.test | bash"]);
        assert.deepEqual(fakeDocument.execCalls, [], "no legacy fallback on success");
        assert.equal(fakeDocument.textareas.length, 0);
      }
    );
  });

  test("falls back to a hidden textarea + execCommand when the Clipboard API rejects", async () => {
    const fakeDocument = createFakeDocument({ execCommand: () => true });
    await withBrowserGlobals(
      {
        navigator: {
          clipboard: {
            writeText: () => Promise.reject(new DOMException("Denied", "NotAllowedError")),
          },
        },
        document: fakeDocument.doc,
      },
      async () => {
        const result = await copyTextToClipboard("apt install -y curl");
        assert.deepEqual(result, { ok: true, method: "exec-command" });
        assert.deepEqual(fakeDocument.execCalls, ["copy"]);
        assert.equal(fakeDocument.textareas.length, 1);
        const textarea = fakeDocument.textareas[0];
        assert.equal(textarea.value, "apt install -y curl");
        assert.equal(fakeDocument.appended[0], textarea, "textarea was attached to body");
        assert.equal(textarea.attributes.readonly, "", "read-only keeps the mobile keyboard closed");
        assert.equal(textarea.attributes["aria-hidden"], "true");
        assert.equal(textarea.style.position, "fixed");
        assert.equal(textarea.focused, true);
        assert.equal(textarea.selected, true);
        assert.deepEqual(textarea.selectionRange, [0, "apt install -y curl".length]);
        assert.equal(textarea.removed, true, "textarea is cleaned up");
        assert.deepEqual(
          fakeDocument.focusOrder,
          ["textarea", "previous"],
          "focus returns to the element that had it"
        );
      }
    );
  });

  test("falls back to execCommand when navigator.clipboard is undefined", async () => {
    const fakeDocument = createFakeDocument({ execCommand: () => true });
    await withBrowserGlobals(
      { navigator: { userAgent: "old WebView" }, document: fakeDocument.doc },
      async () => {
        const result = await copyTextToClipboard("echo hi");
        assert.deepEqual(result, { ok: true, method: "exec-command" });
        assert.deepEqual(fakeDocument.execCalls, ["copy"]);
      }
    );
  });

  test("falls back to execCommand when writeText throws synchronously", async () => {
    const fakeDocument = createFakeDocument({ execCommand: () => true });
    await withBrowserGlobals(
      {
        navigator: {
          clipboard: {
            writeText: () => {
              throw new TypeError("Illegal invocation");
            },
          },
        },
        document: fakeDocument.doc,
      },
      async () => {
        const result = await copyTextToClipboard("echo hi");
        assert.deepEqual(result, { ok: true, method: "exec-command" });
        assert.deepEqual(fakeDocument.execCalls, ["copy"]);
      }
    );
  });

  test("selects the fallback element when both clipboard paths are unavailable", async () => {
    const fakeDocument = createFakeDocument({ execCommand: () => false });
    const codeElement = { tagName: "CODE" };
    await withBrowserGlobals(
      {
        navigator: {
          clipboard: {
            writeText: () => Promise.reject(new Error("blocked")),
          },
        },
        document: fakeDocument.doc,
      },
      async () => {
        const result = await copyTextToClipboard("curl ... | bash", {
          selectionFallback: codeElement as unknown as Element,
        });
        assert.deepEqual(result, { ok: false, method: "none", selected: true });
        assert.deepEqual(fakeDocument.execCalls, ["copy"], "execCommand was still attempted");
        assert.equal(fakeDocument.textareas[0]?.removed, true);
        assert.equal(fakeDocument.selection.ranges.length, 1);
        assert.equal(fakeDocument.selection.ranges[0].contents, codeElement);
      }
    );
  });

  test("reports an unselected failure when execCommand throws and there is nothing to select", async () => {
    const fakeDocument = createFakeDocument({
      execCommand: () => {
        throw new Error("execCommand is not supported");
      },
    });
    await withBrowserGlobals(
      { navigator: {}, document: fakeDocument.doc },
      async () => {
        const result = await copyTextToClipboard("echo hi");
        assert.deepEqual(result, { ok: false, method: "none", selected: false });
        assert.equal(fakeDocument.textareas[0]?.removed, true, "textarea cleaned up after throw");
      }
    );
  });

  test("never rejects when neither navigator nor document exist", async () => {
    await withBrowserGlobals({ navigator: undefined, document: undefined }, async () => {
      const result = await copyTextToClipboard("echo hi", {
        selectionFallback: {} as Element,
      });
      assert.deepEqual(result, { ok: false, method: "none", selected: false });
    });
  });
});

describe("describeCopyFailure", () => {
  test("tells the user the text is already selected when the selection fallback ran", () => {
    assert.match(
      describeCopyFailure({ ok: false, method: "none", selected: true }, "command"),
      /command is selected - long-press/
    );
  });

  test("asks for a manual long-press when nothing could be selected", () => {
    assert.match(
      describeCopyFailure({ ok: false, method: "none", selected: false }, "link"),
      /Long-press the link to select and copy it/
    );
  });
});

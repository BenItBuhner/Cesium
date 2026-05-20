import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_KEYBOARD_SHORTCUT_BINDINGS,
  isNativeEditableShortcutEvent,
  tryDispatchKeyboardShortcut,
  type KeyboardShortcutBindingsMap,
  type ShortcutChordState,
} from "../src/lib/keyboard-shortcuts.ts";

type TestKeyboardEvent = KeyboardEvent & { defaultPrevented: boolean };

function keyEvent(input: {
  key: string;
  code?: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}): TestKeyboardEvent {
  let defaultPrevented = false;
  return {
    key: input.key,
    code:
      input.code ??
      (/^[a-z]$/i.test(input.key) ? `Key${input.key.toUpperCase()}` : input.key),
    altKey: input.altKey ?? false,
    ctrlKey: input.ctrlKey ?? false,
    metaKey: input.metaKey ?? false,
    shiftKey: input.shiftKey ?? false,
    preventDefault: () => {
      defaultPrevented = true;
    },
    get defaultPrevented() {
      return defaultPrevented;
    },
  } as TestKeyboardEvent;
}

function dispatchShortcut(input: {
  event: TestKeyboardEvent;
  bindings?: KeyboardShortcutBindingsMap;
  editableTarget?: boolean;
}): { commandId: string | null; consumed: boolean; defaultPrevented: boolean } {
  let commandId: string | null = null;
  const chordRef: { current: ShortcutChordState | null } = { current: null };
  const consumed = tryDispatchKeyboardShortcut({
    event: input.event,
    platform: "other",
    bindings: input.bindings ?? DEFAULT_KEYBOARD_SHORTCUT_BINDINGS,
    chordRef,
    editableTarget: input.editableTarget,
    onCommand: (id) => {
      commandId = id;
    },
  });
  return { commandId, consumed, defaultPrevented: input.event.defaultPrevented };
}

test("native editing shortcuts are never consumed in editable targets", () => {
  const bindings = {
    ...DEFAULT_KEYBOARD_SHORTCUT_BINDINGS,
    "palette.quickOpen": ["Mod+A"],
  };

  const result = dispatchShortcut({
    event: keyEvent({ key: "a", ctrlKey: true }),
    bindings,
    editableTarget: true,
  });

  assert.equal(result.consumed, false);
  assert.equal(result.defaultPrevented, false);
  assert.equal(result.commandId, null);
});

test("commands explicitly allowed in editable targets still run", () => {
  const result = dispatchShortcut({
    event: keyEvent({ key: "p", ctrlKey: true }),
    editableTarget: true,
  });

  assert.equal(result.consumed, true);
  assert.equal(result.defaultPrevented, true);
  assert.equal(result.commandId, "palette.quickOpen");
});

test("commands not allowed in editable targets pass through", () => {
  const result = dispatchShortcut({
    event: keyEvent({ key: "b", ctrlKey: true }),
    editableTarget: true,
  });

  assert.equal(result.consumed, false);
  assert.equal(result.defaultPrevented, false);
  assert.equal(result.commandId, null);
});

test("commands not allowed in editable targets still run elsewhere", () => {
  const result = dispatchShortcut({
    event: keyEvent({ key: "b", ctrlKey: true }),
    editableTarget: false,
  });

  assert.equal(result.consumed, true);
  assert.equal(result.defaultPrevented, true);
  assert.equal(result.commandId, "workbench.action.toggleSidebarVisibility");
});

test("new chat defaults to Mod+N and runs in editable targets", () => {
  assert.deepEqual(DEFAULT_KEYBOARD_SHORTCUT_BINDINGS["chat.action.newChat"], ["Mod+N"]);

  const result = dispatchShortcut({
    event: keyEvent({ key: "n", ctrlKey: true }),
    editableTarget: true,
  });

  assert.equal(result.consumed, true);
  assert.equal(result.defaultPrevented, true);
  assert.equal(result.commandId, "chat.action.newChat");
});

test("native editing shortcut detector covers common edit commands", () => {
  for (const key of ["a", "c", "v", "x", "y", "z"]) {
    assert.equal(
      isNativeEditableShortcutEvent(keyEvent({ key, ctrlKey: true })),
      true,
      key
    );
  }
  assert.equal(isNativeEditableShortcutEvent(keyEvent({ key: "p", ctrlKey: true })), false);
  assert.equal(
    isNativeEditableShortcutEvent(keyEvent({ key: "a", ctrlKey: true, altKey: true })),
    false
  );
});

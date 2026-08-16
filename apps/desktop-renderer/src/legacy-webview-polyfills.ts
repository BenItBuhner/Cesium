/**
 * Runtime polyfills for old Android System WebViews (Android 11 ships
 * Chromium 83; minSdk 26 devices may run older still). Vite's `es2018`
 * target downlevels syntax but not built-ins, so the modern APIs the
 * workbench uses are installed here, before any other module executes.
 *
 * This must be the first import of the renderer entry. Previously these
 * polyfills lived in the Android shell's injected bootstrap script; owning
 * them in the bundle keeps the native injection minimal and makes the same
 * bundle safe on any host.
 */

type IndexableConstructor = { prototype: { at?: unknown } } | undefined;

const relativeIndex = (length: number, index: unknown): number => {
  const value = Number(index) || 0;
  const integer = value < 0 ? Math.ceil(value) : Math.floor(value);
  return integer < 0 ? length + integer : integer;
};

if (!Array.prototype.at) {
  Object.defineProperty(Array.prototype, "at", {
    configurable: true,
    writable: true,
    value: function at(this: unknown[], index: unknown) {
      return this[relativeIndex(this.length, index)];
    },
  });
}

if (!String.prototype.at) {
  Object.defineProperty(String.prototype, "at", {
    configurable: true,
    writable: true,
    value: function at(this: string, index: unknown) {
      const position = relativeIndex(this.length, index);
      return position < 0 || position >= this.length ? undefined : this.charAt(position);
    },
  });
}

for (const name of [
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]) {
  const ctor = (globalThis as Record<string, unknown>)[name] as IndexableConstructor;
  if (ctor && !ctor.prototype.at) {
    Object.defineProperty(ctor.prototype, "at", {
      configurable: true,
      writable: true,
      value: function at(this: { length: number; [index: number]: unknown }, index: unknown) {
        return this[relativeIndex(this.length, index)];
      },
    });
  }
}

if (!Object.hasOwn) {
  Object.defineProperty(Object, "hasOwn", {
    configurable: true,
    writable: true,
    value: (object: object, key: PropertyKey) =>
      Object.prototype.hasOwnProperty.call(object, key),
  });
}

if (!String.prototype.replaceAll) {
  Object.defineProperty(String.prototype, "replaceAll", {
    configurable: true,
    writable: true,
    value: function replaceAll(
      this: string,
      search: string | RegExp,
      replacement: string
    ) {
      if (search instanceof RegExp) {
        if (!search.global) throw new TypeError("replaceAll requires a global RegExp");
        return this.replace(search, replacement);
      }
      return this.split(String(search)).join(String(replacement));
    },
  });
}

if (!globalThis.structuredClone) {
  globalThis.structuredClone = ((value: unknown) =>
    JSON.parse(JSON.stringify(value))) as typeof structuredClone;
}

if (globalThis.crypto && !globalThis.crypto.randomUUID) {
  (globalThis.crypto as { randomUUID?: () => string }).randomUUID = () =>
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
      const random = (Math.random() * 16) | 0;
      return (char === "x" ? random : (random & 3) | 8).toString(16);
    });
}

export {};

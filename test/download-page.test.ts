import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const downloadPage = readFileSync(
  fileURLToPath(new URL("../src/components/download/DownloadPage.tsx", import.meta.url)),
  "utf8"
);
const platformIcon = readFileSync(
  fileURLToPath(new URL("../src/components/download/PlatformIcon.tsx", import.meta.url)),
  "utf8"
);

describe("download page copy", () => {
  test("drops the release pill, filenames, sizes, and browser-detection theater", () => {
    assert.doesNotMatch(downloadPage, /Latest release/);
    assert.doesNotMatch(downloadPage, /detected from your browser/);
    assert.doesNotMatch(downloadPage, /formatAssetSize/);
    assert.doesNotMatch(downloadPage, /macOS 12/);
    assert.doesNotMatch(downloadPage, /DMG or ZIP/);
    assert.doesNotMatch(downloadPage, /Windows 10\+/);
    assert.doesNotMatch(downloadPage, /Android 8\+/);
    assert.doesNotMatch(downloadPage, /sideload APK/);
    assert.doesNotMatch(downloadPage, /NSIS installer/);
    assert.doesNotMatch(downloadPage, /recommendation\.asset\.name/);
    assert.doesNotMatch(downloadPage, /KIND_LABELS/);
    assert.doesNotMatch(downloadPage, /AppWindow|Smartphone|Watch/);
  });

  test("uses vendor brand marks instead of Lucide placeholders", () => {
    assert.match(downloadPage, /PlatformIcon/);
    assert.match(platformIcon, /label: "Apple"/);
    assert.match(platformIcon, /label: "Windows"/);
    assert.match(platformIcon, /label: "Linux"/);
    assert.match(platformIcon, /label: "Android"/);
    assert.match(platformIcon, /label: "Wear OS"/);
    assert.match(platformIcon, /label: "iOS"/);
    assert.match(platformIcon, /label: "Web"/);
    assert.doesNotMatch(platformIcon, /lucide-react/);
  });

  test("still signs in from the header", () => {
    assert.match(downloadPage, /href="\/sign-in"/);
    assert.doesNotMatch(downloadPage, /Launch workbench/);
  });
});

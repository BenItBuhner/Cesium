import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ACTIVE_AGENT_BACKEND_IDS } from "../packages/core/src/active-agent-backends.ts";
import {
  AGENT_BACKEND_ICON_FILES,
  hasAgentBackendIconAsset,
} from "../src/lib/agent-backend-icons.ts";

const PUBLIC_ICON_DIRS = [
  "public/agent-backend-icons",
  "apps/web/public/agent-backend-icons",
  "apps/desktop-renderer/public/agent-backend-icons",
  "apps/mobile/android/app/src/main/assets/workbench/agent-backend-icons",
] as const;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("every active harness has a dedicated light/dark icon asset", () => {
  for (const id of ACTIVE_AGENT_BACKEND_IDS) {
    assert.equal(hasAgentBackendIconAsset(id), true, `${id} missing icon mapping`);
    const files = AGENT_BACKEND_ICON_FILES[id];
    assert.ok(files, `${id} missing AGENT_BACKEND_ICON_FILES entry`);
    assert.ok(files.light.endsWith(".svg"), `${id} light icon must be svg`);
    assert.ok(files.dark.endsWith(".svg"), `${id} dark icon must be svg`);
    for (const dir of PUBLIC_ICON_DIRS) {
      for (const file of [files.light, files.dark]) {
        const full = path.join(REPO_ROOT, dir, file);
        assert.ok(existsSync(full), `missing ${dir}/${file} for ${id}`);
      }
    }
  }
});

test("named harness icons resolve to expected filenames", () => {
  assert.deepEqual(AGENT_BACKEND_ICON_FILES["cesium-agent"], {
    light: "Cesium-Light.svg",
    dark: "Cesium-Dark.svg",
  });
  assert.deepEqual(AGENT_BACKEND_ICON_FILES["pi-agent"], {
    light: "Pi-Light.svg",
    dark: "Pi-Dark.svg",
  });
  assert.deepEqual(AGENT_BACKEND_ICON_FILES["google-antigravity-acp"], {
    light: "Antigravity-Light.svg",
    dark: "Antigravity-Dark.svg",
  });
  assert.deepEqual(AGENT_BACKEND_ICON_FILES["devin-acp"], {
    light: "Devin-Light.svg",
    dark: "Devin-Dark.svg",
  });
});

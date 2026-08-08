import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  INTEGRATION_ICON_FILES,
  hasIntegrationIconAsset,
  integrationIconLabel,
  normalizeIntegrationIconId,
  type IntegrationIconId,
} from "../src/lib/integration-icons.ts";

const PUBLIC_ICON_DIRS = [
  "public/integration-icons",
  "apps/web/public/integration-icons",
  "apps/desktop-renderer/public/integration-icons",
  "apps/mobile/android/app/src/main/assets/workbench/integration-icons",
] as const;

const PROVIDER_IDS: IntegrationIconId[] = [
  "github",
  "linear",
  "slack",
  "manual",
];

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("every Cloud Agents provider has a dedicated light/dark icon asset", () => {
  for (const id of PROVIDER_IDS) {
    assert.equal(hasIntegrationIconAsset(id), true, `${id} missing icon mapping`);
    const files = INTEGRATION_ICON_FILES[id];
    assert.ok(files, `${id} missing INTEGRATION_ICON_FILES entry`);
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

test("named integration icons resolve to expected filenames and labels", () => {
  assert.deepEqual(INTEGRATION_ICON_FILES.github, {
    light: "GitHub-Light.svg",
    dark: "GitHub-Dark.svg",
  });
  assert.deepEqual(INTEGRATION_ICON_FILES.linear, {
    light: "Linear-Light.svg",
    dark: "Linear-Dark.svg",
  });
  assert.deepEqual(INTEGRATION_ICON_FILES.slack, {
    light: "Slack-Light.svg",
    dark: "Slack-Dark.svg",
  });
  assert.deepEqual(INTEGRATION_ICON_FILES.manual, {
    light: "Cesium-Light.svg",
    dark: "Cesium-Dark.svg",
  });
  assert.equal(integrationIconLabel("github"), "GitHub");
  assert.equal(integrationIconLabel("linear"), "Linear");
  assert.equal(integrationIconLabel("slack"), "Slack");
  assert.equal(integrationIconLabel("manual"), "Cloud Agents");
});

test("normalizeIntegrationIconId accepts known providers and rejects unknowns", () => {
  assert.equal(normalizeIntegrationIconId("GitHub"), "github");
  assert.equal(normalizeIntegrationIconId("LINEAR"), "linear");
  assert.equal(normalizeIntegrationIconId("slack"), "slack");
  assert.equal(normalizeIntegrationIconId("manual"), "manual");
  assert.equal(normalizeIntegrationIconId("notion"), null);
  assert.equal(normalizeIntegrationIconId(""), null);
  assert.equal(normalizeIntegrationIconId(null), null);
});

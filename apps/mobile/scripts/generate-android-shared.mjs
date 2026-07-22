import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const outIndex = process.argv.indexOf("--outDir");
if (outIndex < 0 || !process.argv[outIndex + 1]) {
  throw new Error("Usage: generate-android-shared.mjs --outDir <directory>");
}
const outDir = resolve(process.argv[outIndex + 1]);
const resOutIndex = process.argv.indexOf("--resOutDir");
const resOutDir =
  resOutIndex >= 0 && process.argv[resOutIndex + 1]
    ? resolve(process.argv[resOutIndex + 1])
    : null;

const design = await import(
  pathToFileURL(join(repoRoot, "packages/design/dist/theme-tokens.js")).href
);
const watchSourcePath = join(repoRoot, "packages/core/src/watch-agent-contract.ts");
const watchSource = ts.createSourceFile(
  watchSourcePath,
  await readFile(watchSourcePath, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS
);

function literalValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isAsExpression(node)) return literalValue(node.expression);
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literalValue);
  if (ts.isObjectLiteralExpression(node)) {
    return Object.fromEntries(
      node.properties.map((property) => {
        if (!ts.isPropertyAssignment(property)) {
          throw new Error(`Unsupported property in ${watchSourcePath}`);
        }
        const key = ts.isIdentifier(property.name)
          ? property.name.text
          : property.name.text;
        return [key, literalValue(property.initializer)];
      })
    );
  }
  throw new Error(`Unsupported literal in ${watchSourcePath}: ${node.getText(watchSource)}`);
}

function readWatchConstant(name) {
  for (const statement of watchSource.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer
      ) {
        return literalValue(declaration.initializer);
      }
    }
  }
  throw new Error(`Missing ${name} in ${watchSourcePath}`);
}

const watch = {
  WATCH_SCHEMA_VERSION: readWatchConstant("WATCH_SCHEMA_VERSION"),
  WATCH_AGENT_ACTIONS: readWatchConstant("WATCH_AGENT_ACTIONS"),
  WATCH_DATA_PATHS: readWatchConstant("WATCH_DATA_PATHS"),
};

const colorKeys = {
  Background: "--background",
  BackgroundMain: "--bg-main",
  Panel: "--bg-panel",
  Card: "--bg-card",
  CardHover: "--bg-card-hover",
  Border: "--border-card",
  BorderSubtle: "--border-subtle",
  TextPrimary: "--text-primary",
  TextSecondary: "--text-secondary",
  TextDisabled: "--text-disabled",
  Accent: "--accent",
  AccentSoft: "--accent-bg",
  AskAccent: "--ask-accent",
  GoalAccent: "--goal-accent",
  PlanAccent: "--plan-accent",
  PlanAccentDark: "--plan-accent-dark",
  PlanAccentPanel: "--plan-accent-bg",
  WorkflowAccent: "--workflow-accent",
  WorkflowAccentDark: "--workflow-accent-dark",
  WorkflowAccentPanel: "--workflow-accent-bg",
  Danger: "--debug-accent",
};
const dimensionKeys = {
  RadiusCard: "--radius-card",
  RadiusTab: "--radius-tab",
  RadiusPill: "--radius-pill",
  FontBody: "--font-size-body",
  FontSmall: "--font-size-small",
  FontMeta: "--font-size-meta",
};

function colorLong(value) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return `0xFF${hex[1].toUpperCase()}L`;
  const rgba = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (rgba) {
    const parts = rgba[1].split(",").map((part) => Number(part.trim()));
    const [red, green, blue, alpha = 1] = parts;
    const a = Math.round(alpha * 255);
    return `0x${[a, red, green, blue]
      .map((part) => Math.max(0, Math.min(255, part)).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()}L`;
  }
  throw new Error(`Unsupported Android color token: ${value}`);
}

function numberFloat(value) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) throw new Error(`Unsupported dimension token: ${value}`);
  return `${parsed}f`;
}

function tokenObject(name, tokens) {
  const colors = Object.entries(colorKeys)
    .map(([field, key]) => `    const val ${field}: Long = ${colorLong(tokens[key])}`)
    .join("\n");
  const dimensions = Object.entries(dimensionKeys)
    .map(([field, key]) => `    const val ${field}: Float = ${numberFloat(tokens[key])}`)
    .join("\n");
  return `  object ${name} {\n${colors}\n${dimensions}\n  }`;
}

const actions = watch.WATCH_AGENT_ACTIONS;
const paths = watch.WATCH_DATA_PATHS;
const actionCases = actions
  .map((action) => {
    const pathAction = action === "open" ? "open_on_phone" : action;
    return `      "${action}" -> ACTION_PREFIX + "/${pathAction}"`;
  })
  .join("\n");
const pathCases = actions
  .filter((action) => action !== "open")
  .map((action) => `      ACTION_PREFIX + "/${action}" -> "${action}"`)
  .join("\n");

const kotlin = `// AUTO-GENERATED from @cesium/core and @cesium/design. DO NOT EDIT.
package com.cesium.shared.generated

object CesiumWatchSchema {
  const val VERSION: Int = ${watch.WATCH_SCHEMA_VERSION}
  val ACTIONS: Set<String> = setOf(${actions.map((action) => `"${action}"`).join(", ")})
}

object CesiumDataLayerPaths {
  const val CURRENT_PROJECTION: String = "${paths.currentProjection}"
  const val CURRENT_CONFIG: String = "${paths.currentConfig}"
  const val ACTION_PREFIX: String = "${paths.actionPrefix}"
  fun actionPath(action: String): String? =
    when (action) {
${actionCases}
      else -> null
    }
  fun actionForPath(path: String): String? =
    when (path) {
${pathCases}
      else -> null
    }
}

object CesiumCapabilities {
  const val PHONE_RELAY: String = "${paths.phoneRelayCapability}"
  const val WATCH_CLIENT: String = "${paths.watchClientCapability}"
}

object CesiumDesignTokens {
${tokenObject("Light", design.DEFAULT_THEME_TOKENS_LIGHT)}
${tokenObject("Dark", design.DEFAULT_THEME_TOKENS_DARK)}
}
`;

const packageDir = join(outDir, "com/cesium/shared/generated");
await mkdir(packageDir, { recursive: true });
await writeFile(join(packageDir, "CesiumGenerated.kt"), kotlin, "utf8");
await writeFile(
  join(outDir, "cesium-contract-snapshot.json"),
  `${JSON.stringify(
    {
      schemaVersion: watch.WATCH_SCHEMA_VERSION,
      actions,
      paths,
      darkTokens: Object.fromEntries(
        Object.values(colorKeys).map((key) => [key, design.DEFAULT_THEME_TOKENS_DARK[key]])
      ),
    },
    null,
    2
  )}\n`,
  "utf8"
);
if (resOutDir) {
  const valuesDir = join(resOutDir, "values");
  await mkdir(valuesDir, { recursive: true });
  await writeFile(
    join(valuesDir, "cesium_design_generated.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<resources>
  <color name="cesium_design_background_dark">${design.DEFAULT_THEME_TOKENS_DARK["--background"]}</color>
  <color name="cesium_design_background_light">${design.DEFAULT_THEME_TOKENS_LIGHT["--background"]}</color>
  <color name="cesium_design_plan_accent_dark">${design.DEFAULT_THEME_TOKENS_DARK["--plan-accent"]}</color>
  <color name="cesium_design_text_primary_dark">${design.DEFAULT_THEME_TOKENS_DARK["--text-primary"]}</color>
</resources>
`,
    "utf8"
  );
}
console.log(`Generated shared Android sources in ${outDir}`);

import type {
  ExtensionActivitySurfaceCapability,
  ExtensionCommandContributionCapability,
  ExtensionCompatibilityStatus,
  ExtensionIconDescriptor,
  ExtensionLanguageContributionCapability,
  ExtensionManifestCapabilities,
  ExtensionStaticContributionCapability,
  ExtensionUnsupportedContributionCapability,
} from "./types.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function labelFallback(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

function fallbackIcon(label: string): ExtensionIconDescriptor {
  return { kind: "fallback", label: label.slice(0, 2).toUpperCase() };
}

function renderForResourceIcon(path: string): "mask" | "image" {
  const lower = path.toLowerCase().split(/[?#]/, 1)[0] ?? "";
  // VS Code activity bar SVGs are normally monochrome. Keep raster/color assets
  // as images so colored logos do not get destroyed by mask rendering.
  return lower.endsWith(".svg") ? "mask" : "image";
}

export function classifyExtensionIcon(icon: unknown, label: string): ExtensionIconDescriptor {
  const stringIcon = asString(icon);
  if (stringIcon) {
    const codicon = stringIcon.match(/^\$\(([^)]+)\)$/);
    if (codicon?.[1]) {
      return { kind: "codicon", name: codicon[1] };
    }
    return {
      kind: "resource",
      path: stringIcon,
      render: renderForResourceIcon(stringIcon),
    };
  }

  const record = asRecord(icon);
  const dark = asString(record.dark);
  const light = asString(record.light);
  const themed = dark ?? light;
  if (themed) {
    return {
      kind: "resource",
      path: themed,
      render: renderForResourceIcon(themed),
      theme: dark ? "dark" : "light",
    };
  }

  return fallbackIcon(label);
}

function viewVisibility(view: Record<string, unknown>): "always" | "conditional" {
  return asString(view.when) ? "conditional" : "always";
}

function collectActivitySurfaces(
  contributes: Record<string, unknown>,
  extensionLabel: string
): ExtensionActivitySurfaceCapability[] {
  const containers = asRecord(asRecord(contributes.viewsContainers).activitybar);
  const views = asRecord(contributes.views);
  const activityContainers = asArray(asRecord(contributes.viewsContainers).activitybar);
  const surfaces: ExtensionActivitySurfaceCapability[] = [];

  for (const container of activityContainers) {
    const containerRecord = asRecord(container);
    const containerId = asString(containerRecord.id);
    if (!containerId) continue;
    const title = labelFallback(asString(containerRecord.title), extensionLabel);
    const containerViews = asArray(views[containerId]);
    const icon = classifyExtensionIcon(containerRecord.icon, title);

    for (const rawView of containerViews) {
      const view = asRecord(rawView);
      const surfaceId = asString(view.id);
      if (!surfaceId) continue;
      const viewTitle = labelFallback(asString(view.name), title);
      const type = asString(view.type);
      const kind = type === "webview" ? "activity.webviewView" : "activity.treeView";
      surfaces.push({
        kind,
        containerId,
        surfaceId,
        title: viewTitle,
        icon,
        visibility: viewVisibility(view),
        when: asString(view.when),
      });
    }
  }

  // Keep TypeScript happy about the intentionally unused object lookup above
  // while preserving one place for future non-activity container support.
  void containers;
  return surfaces;
}

function collectStaticContributions(
  contributes: Record<string, unknown>
): ExtensionStaticContributionCapability[] {
  const output: ExtensionStaticContributionCapability[] = [];
  for (const theme of asArray(contributes.themes)) {
    const record = asRecord(theme);
    const label = labelFallback(asString(record.label), asString(record.id) ?? "Theme");
    output.push({
      kind: "static.theme",
      id: asString(record.id) ?? label,
      label,
      path: asString(record.path),
    });
  }
  for (const iconTheme of asArray(contributes.iconThemes)) {
    const record = asRecord(iconTheme);
    const label = labelFallback(asString(record.label), asString(record.id) ?? "Icon Theme");
    output.push({
      kind: "static.iconTheme",
      id: asString(record.id) ?? label,
      label,
      path: asString(record.path),
    });
  }
  for (const productIconTheme of asArray(contributes.productIconThemes)) {
    const record = asRecord(productIconTheme);
    const label = labelFallback(asString(record.label), asString(record.id) ?? "Product Icon Theme");
    output.push({
      kind: "static.productIconTheme",
      id: asString(record.id) ?? label,
      label,
      path: asString(record.path),
    });
  }
  return output;
}

function collectCommandContributions(
  contributes: Record<string, unknown>
): ExtensionCommandContributionCapability[] {
  const commandsById = new Map<string, { title: string; category?: string }>();
  for (const rawCommand of asArray(contributes.commands)) {
    const command = asRecord(rawCommand);
    const id = asString(command.command);
    if (!id) continue;
    commandsById.set(id, {
      title: labelFallback(asString(command.title), id),
      category: asString(command.category),
    });
  }

  const output: ExtensionCommandContributionCapability[] = [];
  for (const [command, meta] of commandsById) {
    output.push({ kind: "commandOnly", command, title: meta.title, category: meta.category });
  }

  const menus = asRecord(contributes.menus);
  for (const rawMenu of asArray(menus["editor/context"])) {
    const menu = asRecord(rawMenu);
    const command = asString(menu.command);
    if (!command) continue;
    const meta = commandsById.get(command);
    output.push({
      kind: "editor.contextMenu",
      command,
      title: meta?.title ?? command,
      category: meta?.category,
      when: asString(menu.when),
    });
  }
  return output;
}

function collectLanguageContributions(
  contributes: Record<string, unknown>
): ExtensionLanguageContributionCapability[] {
  const output: ExtensionLanguageContributionCapability[] = [];
  for (const language of asArray(contributes.languages)) {
    const id = asString(asRecord(language).id);
    if (id) output.push({ kind: "language.diagnostics", languageId: id });
  }
  return output;
}

function collectUnsupportedContributions(
  contributes: Record<string, unknown>
): ExtensionUnsupportedContributionCapability[] {
  const unsupported: ExtensionUnsupportedContributionCapability[] = [];
  if (contributes.debuggers) {
    unsupported.push({ kind: "unsupported.debug", reason: "Debugger APIs are not implemented." });
  }
  if (contributes.notebooks || contributes.notebookRenderer) {
    unsupported.push({ kind: "unsupported.notebook", reason: "Notebook APIs are not implemented." });
  }
  if (contributes.testing) {
    unsupported.push({ kind: "unsupported.testing", reason: "Testing APIs are not implemented." });
  }
  if (contributes.scm) {
    unsupported.push({ kind: "unsupported.scm", reason: "SCM provider APIs are not implemented." });
  }
  return unsupported;
}

function compatibilityStatus(input: {
  hasRuntimeEntrypoint: boolean;
  staticContributions: ExtensionStaticContributionCapability[];
  activitySurfaces: ExtensionActivitySurfaceCapability[];
  unsupportedContributions: ExtensionUnsupportedContributionCapability[];
  reasons: string[];
}): ExtensionCompatibilityStatus {
  if (input.unsupportedContributions.length > 0) return "degraded";
  if (!input.hasRuntimeEntrypoint && input.staticContributions.length > 0) return "staticOnly";
  if (input.activitySurfaces.length > 0 || input.hasRuntimeEntrypoint) return input.reasons.length ? "degraded" : "supported";
  return "hidden";
}

export function classifyExtensionManifest(rawManifest: Record<string, unknown>): ExtensionManifestCapabilities {
  const contributes = asRecord(rawManifest.contributes);
  const displayName = labelFallback(asString(rawManifest.displayName), asString(rawManifest.name) ?? "Extension");
  const staticContributions = collectStaticContributions(contributes);
  const activitySurfaces = collectActivitySurfaces(contributes, displayName);
  const commandContributions = collectCommandContributions(contributes);
  const languageContributions = collectLanguageContributions(contributes);
  const unsupportedContributions = collectUnsupportedContributions(contributes);
  const reasons: string[] = [];

  for (const unsupported of unsupportedContributions) {
    reasons.push(unsupported.reason);
  }
  if (!rawManifest.main && !rawManifest.browser && staticContributions.length === 0) {
    reasons.push("No runtime entrypoint or supported static contribution was found.");
  }
  if (activitySurfaces.some((surface) => surface.visibility === "conditional")) {
    reasons.push("Some contributed views are gated by unsupported when-clause evaluation.");
  }

  return {
    status: compatibilityStatus({
      hasRuntimeEntrypoint: Boolean(rawManifest.main || rawManifest.browser),
      staticContributions,
      activitySurfaces,
      unsupportedContributions,
      reasons,
    }),
    reasons,
    activitySurfaces,
    staticContributions,
    commandContributions,
    languageContributions,
    unsupportedContributions,
  };
}

import { collectCesiumUsage } from "./cesium.js";
import { collectClaudeCodeUsage } from "./claude-code.js";
import { collectCodexUsage } from "./codex.js";
import { collectGeminiUsage } from "./gemini.js";
import { collectOpenCodeUsage } from "./opencode.js";
import { collectPiUsage } from "./pi.js";
import { unavailableReport } from "./helpers.js";
import type { ProviderUsageReport, UsageOverview } from "./types.js";

export type { ProviderUsageReport, UsageOverview } from "./types.js";

const CACHE_TTL_MS = 60_000;

/** Harnesses whose usage lives server-side only - surfaced so the page can say why. */
const CLOUD_ONLY_PROVIDERS: Array<{
  id: string;
  label: string;
  vendor: string;
  reason: string;
}> = [
  {
    id: "cursor-sdk",
    label: "Cursor",
    vendor: "Cursor",
    reason:
      "Cursor tracks usage in the cloud; check cursor.com/settings for plan usage. No local session data is exposed.",
  },
  {
    id: "devin",
    label: "Devin",
    vendor: "Cognition",
    reason:
      "Devin runs remotely and does not persist usage data on this machine. See the Devin dashboard for ACU consumption.",
  },
  {
    id: "grok-build",
    label: "Grok Build",
    vendor: "xAI",
    reason:
      "Grok Build does not expose usage or quota data locally. See console.x.ai for account usage.",
  },
];

type Collector = {
  id: string;
  label: string;
  vendor: string;
  run: (sinceMs: number) => Promise<ProviderUsageReport>;
};

const COLLECTORS: Collector[] = [
  { id: "codex", label: "Codex", vendor: "OpenAI", run: collectCodexUsage },
  {
    id: "claude-code",
    label: "Claude Code",
    vendor: "Anthropic",
    run: collectClaudeCodeUsage,
  },
  {
    id: "gemini",
    label: "Gemini CLI / Antigravity",
    vendor: "Google",
    run: collectGeminiUsage,
  },
  { id: "opencode", label: "OpenCode", vendor: "OpenCode", run: collectOpenCodeUsage },
  { id: "pi", label: "Pi Agent", vendor: "Pi", run: collectPiUsage },
  { id: "cesium-agent", label: "Cesium Agent", vendor: "Cesium", run: collectCesiumUsage },
];

const cache = new Map<number, { at: number; overview: UsageOverview }>();

async function buildOverview(lookbackDays: number): Promise<UsageOverview> {
  const sinceMs = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  const providers = await Promise.all(
    COLLECTORS.map(async (collector) => {
      try {
        return await collector.run(sinceMs);
      } catch (error) {
        return unavailableReport(
          collector,
          `Failed to read usage data: ${error instanceof Error ? error.message : String(error)}`,
          null
        );
      }
    })
  );
  for (const cloudOnly of CLOUD_ONLY_PROVIDERS) {
    providers.push(unavailableReport(cloudOnly, cloudOnly.reason, null));
  }
  return {
    generatedAt: new Date().toISOString(),
    lookbackDays,
    providers,
  };
}

export async function getUsageOverview(options: {
  days: number;
  refresh?: boolean;
}): Promise<UsageOverview> {
  const days = Math.max(1, Math.min(365, Math.floor(options.days) || 30));
  const cached = cache.get(days);
  if (!options.refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.overview;
  }
  const overview = await buildOverview(days);
  cache.set(days, { at: Date.now(), overview });
  return overview;
}

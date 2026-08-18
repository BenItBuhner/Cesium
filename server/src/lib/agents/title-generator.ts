import { titleGenerationProcessEnv } from "../transcription-env.js";
import {
  getCesiumAgentSettings,
  resolveCesiumAuth,
} from "../cesium-agent-settings.js";
import { runAdapter } from "./cesium/cesium-model-adapters.js";
import { updateConversationRecord } from "./session-store.js";

const TITLE_TIMEOUT_MS = 10_000;
const TITLE_CATALOG_TIMEOUT_MS = 20_000;
const TITLE_MAX_INPUT_CHARS = 200;
const TITLE_MAX_RETRIES = 2;

const SYSTEM_PROMPT =
  "You generate concise chat titles. Given a user message, output a 3-5 word title that summarizes the topic. " +
  "Casing: use natural headline-style wording, not mechanical Title Case on every word. Preserve product, brand, and platform names as they are usually written (e.g. iPhone, iOS, macOS, GitHub). " +
  "Use standard forms for abbreviations and acronyms (e.g. ACP, API, CLI), not mixed case imposed by title rules. " +
  "Output ONLY the title. No quotes, no trailing punctuation, no explanation.";

function validateTitle(raw: string): string | null {
  const trimmed = raw.trim().replace(/^["'`]+|["'`]+$/g, "").replace(/[.:;,!?]+$/, "");
  const words = trimmed.split(/\s+/).filter(Boolean);
  // Models frequently return a word or two outside the requested 3-5 range;
  // a slightly long-but-good title beats discarding it and falling back to
  // "New chat". Reject only clearly malformed output (empty or run-on prose).
  if (words.length < 1 || words.length > 10 || trimmed.length > 80) {
    return null;
  }
  return words.join(" ");
}

/** Test seam: overrides the settings-selected title model id. */
let titleModelIdOverride: string | null | undefined;

export function setTitleModelIdOverrideForTests(modelId: string | null | undefined): void {
  titleModelIdOverride = modelId;
}

async function configuredTitleModelId(): Promise<string | null> {
  if (titleModelIdOverride !== undefined) {
    return titleModelIdOverride;
  }
  try {
    const settings = await getCesiumAgentSettings();
    return settings.titleGeneration.modelId;
  } catch {
    return null;
  }
}

/**
 * Title generation via a Settings-selected Cesium catalog model. Supports the
 * same providers as chat turns, including OAuth subscription accounts
 * (ChatGPT/Codex, SpaceXAI SuperGrok).
 */
async function callCatalogTitleModel(modelId: string, userMessage: string): Promise<string> {
  const auth = await resolveCesiumAuth({ modelId });
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`Title model ${modelId} timed out after ${TITLE_CATALOG_TIMEOUT_MS}ms`)),
      TITLE_CATALOG_TIMEOUT_MS
    );
  });
  const result = await Promise.race([
    runAdapter({
      apiKind: auth.apiKind,
      apiKey: auth.apiKey,
      baseUrl: auth.baseUrl,
      providerId: auth.providerId,
      oauth: auth.oauth,
      modelId,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage.slice(0, TITLE_MAX_INPUT_CHARS) },
      ],
      tools: [],
    }),
    timeout,
  ]);
  const content = result.text.trim();
  if (!content) {
    throw new Error(`Empty response from title model ${modelId}`);
  }
  return content;
}

async function callEnvTitleModel(userMessage: string): Promise<string> {
  const { baseUrl, apiKey, titleModel } = titleGenerationProcessEnv();

  if (!baseUrl || !apiKey) {
    throw new Error("Title generation provider not configured.");
  }

  const endpoint = baseUrl.endsWith("/")
    ? `${baseUrl}chat/completions`
    : `${baseUrl}/chat/completions`;

  const body = JSON.stringify({
    model: titleModel,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: userMessage.slice(0, TITLE_MAX_INPUT_CHARS),
      },
    ],
    max_tokens: 500,
    temperature: 0.3,
    stream: false,
    reasoning_format: "hidden",
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error(
        `[title-generator] Title API error ${response.status}: ${errorText.slice(0, 200)}`
      );
      throw new Error(`Title API returned ${response.status}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) {
      console.error("[title-generator] Empty content from model. Full response:", JSON.stringify(payload).slice(0, 300));
      throw new Error("Empty response from title model");
    }

    return content;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One title attempt. The Settings-selected catalog model wins when set; the
 * Voice settings / env-configured pipeline (OPENCURSOR_TITLE_MODEL) is the
 * fallback so a broken selection degrades instead of silencing titles entirely.
 */
async function callTitleModel(userMessage: string): Promise<string> {
  const configuredModelId = await configuredTitleModelId();
  if (configuredModelId) {
    try {
      return await callCatalogTitleModel(configuredModelId, userMessage);
    } catch (error) {
      console.warn(
        `[title-generator] Configured title model ${configuredModelId} failed, falling back to env pipeline:`,
        error instanceof Error ? error.message : error
      );
    }
  }
  return callEnvTitleModel(userMessage);
}

export async function generateTitleFromText(
  userMessage: string
): Promise<string | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= TITLE_MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
      const raw = await callTitleModel(userMessage);
      const validated = validateTitle(raw);
      if (validated) {
        return validated;
      }
      console.warn(`[title-generator] Invalid title from model (attempt ${attempt + 1}): "${raw}"`);
      lastError = new Error(`Invalid title format: "${raw}"`);
    } catch (error) {
      lastError = error;
      console.warn(`[title-generator] Attempt ${attempt + 1} failed:`, error instanceof Error ? error.message : error);
    }
  }

  console.error(
    `[title-generator] All attempts failed for draft title generation. Last error:`,
    lastError instanceof Error ? lastError.message : lastError
  );
  return null;
}

export async function generateConversationTitle(
  workspaceId: string,
  conversationId: string,
  userMessage: string
): Promise<void> {
  const title = await generateTitleFromText(userMessage);
  if (title) {
    await updateConversationRecord(workspaceId, conversationId, (current) =>
      current.title === "New chat"
        ? { ...current, title }
        : current
    );
  }
}

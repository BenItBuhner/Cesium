import { titleGenerationProcessEnv } from "../transcription-env.js";
import { updateConversationRecord } from "./session-store.js";

const TITLE_TIMEOUT_MS = 10_000;
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
  if (words.length < 3 || words.length > 5) {
    return null;
  }
  return words.join(" ");
}

async function callGroqTitleModel(userMessage: string): Promise<string> {
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
        `[title-generator] Groq API error ${response.status}: ${errorText.slice(0, 200)}`
      );
      throw new Error(`Groq title API returned ${response.status}`);
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

export async function generateTitleFromText(
  userMessage: string
): Promise<string | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= TITLE_MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
      const raw = await callGroqTitleModel(userMessage);
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

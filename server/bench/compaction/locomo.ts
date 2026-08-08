/**
 * LoCoMo third-party benchmark adapter (snap-research/locomo).
 *
 * LoCoMo is a published long-conversation memory benchmark: 10 multi-session
 * persona dialogs (19-32 sessions, ~11-22k tokens each) with ~2,000 QA pairs
 * across five categories (multi-hop, temporal, open-domain, single-hop,
 * adversarial). Using it alongside our synthetic gauntlet guards against
 * overfitting to generator idiosyncrasies: none of this content is ours.
 *
 * Mapping: every dialog turn becomes a user message ("[Speaker]: text", with
 * session date headers so temporal questions stay answerable, and BLIP photo
 * captions inlined). The agent under test acts as an observer that must retain
 * the dialog through its own compaction, then answer QA probes.
 *
 * Adversarial questions (category 5) expect refusal — mapped to our "absent"
 * category (correct answer: UNKNOWN).
 *
 * Dataset: auto-downloaded to /tmp/locomo10.json from the official repo when
 * missing (override path with LOCOMO_PATH).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AgentStoredEvent } from "../../src/lib/agents/types.js";
import type { BenchProbe, BenchScenario } from "./scenarios.js";

const LOCOMO_URL =
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json";

export function locomoPath(): string {
  return process.env.LOCOMO_PATH?.trim() || "/tmp/locomo10.json";
}

type LocomoTurn = {
  speaker: string;
  dia_id: string;
  text: string;
  blip_caption?: string;
};

type LocomoQa = {
  question: string;
  answer?: string | number;
  adversarial_answer?: string;
  evidence?: string;
  category: number | string;
};

type LocomoItem = {
  sample_id: string;
  qa: LocomoQa[];
  conversation: Record<string, unknown> & {
    speaker_a?: string;
    speaker_b?: string;
  };
};

export async function ensureLocomoDataset(): Promise<LocomoItem[]> {
  const path = locomoPath();
  if (!existsSync(path)) {
    const response = await fetch(LOCOMO_URL);
    if (!response.ok) {
      throw new Error(
        `Failed to download LoCoMo dataset (HTTP ${response.status}). ` +
          `Download ${LOCOMO_URL} manually and set LOCOMO_PATH.`
      );
    }
    writeFileSync(path, await response.text());
  }
  return JSON.parse(readFileSync(path, "utf8")) as LocomoItem[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function categoryFor(qa: LocomoQa): BenchProbe["category"] {
  switch (Number(qa.category)) {
    case 1:
      return "multi-hop";
    case 2:
      return "temporal";
    case 5:
      return "absent";
    default:
      return "fact";
  }
}

export function locomoToScenario(
  item: LocomoItem,
  options: { index: number; maxProbes?: number; seed?: number } = { index: 0 }
): BenchScenario {
  const rand = mulberry32(options.seed ?? 97);
  const conversation = item.conversation;
  const sessionKeys = Object.keys(conversation)
    .filter((key) => /^session_\d+$/.test(key))
    .sort((a, b) => Number(a.split("_")[1]) - Number(b.split("_")[1]));

  const events: AgentStoredEvent[] = [];
  let seq = 0;
  const base = { conversationId: `locomo-${options.index}` };
  const pushUser = (content: string) => {
    seq += 1;
    events.push({
      ...base,
      seq,
      eventId: `u-${seq}`,
      createdAt: seq,
      kind: "user_message",
      messageId: `m-${seq}`,
      content,
    });
  };
  const pushAssistant = (text: string) => {
    seq += 1;
    const chunkSeq = seq;
    seq += 1;
    const messageId = `am-${chunkSeq}`;
    events.push(
      {
        ...base,
        seq: chunkSeq,
        eventId: `ac-${chunkSeq}`,
        createdAt: chunkSeq,
        kind: "assistant_message_chunk",
        messageId,
        text,
      },
      {
        ...base,
        seq,
        eventId: `ae-${seq}`,
        createdAt: seq,
        kind: "assistant_message_end",
        messageId,
        stopReason: "end_turn",
      }
    );
  };

  for (const key of sessionKeys) {
    const turns = conversation[key] as LocomoTurn[];
    const dateTime = conversation[`${key}_date_time`];
    const sessionNo = key.split("_")[1];
    // Sessions arrive in batches of a few dialog turns per user message so the
    // event stream has realistic turn granularity for compaction splits.
    const header = `SESSION ${sessionNo}${dateTime ? ` — ${dateTime}` : ""}`;
    let batch: string[] = [header];
    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index]!;
      const caption = turn.blip_caption ? ` [shared a photo: ${turn.blip_caption}]` : "";
      batch.push(`${turn.speaker}: ${turn.text}${caption}`);
      if (batch.length >= 7 || index === turns.length - 1) {
        pushUser(batch.join("\n"));
        pushAssistant("Noted.");
        batch = [];
      }
    }
  }

  // Balanced probe sampling across categories.
  const byCategory = new Map<string, LocomoQa[]>();
  for (const qa of item.qa) {
    const key = String(qa.category);
    if (!byCategory.has(key)) {
      byCategory.set(key, []);
    }
    byCategory.get(key)!.push(qa);
  }
  const maxProbes = options.maxProbes ?? 40;
  const perCategory = Math.max(2, Math.ceil(maxProbes / byCategory.size));
  const probes: BenchProbe[] = [];
  for (const [category, list] of byCategory) {
    const shuffled = [...list].sort(() => rand() - 0.5).slice(0, perCategory);
    shuffled.forEach((qa, index) => {
      const isAdversarial = Number(qa.category) === 5;
      const answer = String(qa.answer ?? "").trim();
      if (!isAdversarial && !answer) {
        return;
      }
      probes.push({
        id: `locomo-${options.index}-c${category}-${index}`,
        question: qa.question,
        expected: isAdversarial ? ["unknown"] : [answer],
        matcher: isAdversarial ? "contains" : "fuzzy",
        category: categoryFor(qa),
        plantedAtTurn: 0,
      });
    });
  }

  return {
    id: `locomo-${options.index}`,
    title: `LoCoMo conversation ${options.index} (${item.sample_id})`,
    events,
    probes: probes.slice(0, maxProbes),
  };
}

export async function locomoScenario(options: {
  index: number;
  maxProbes?: number;
  seed?: number;
}): Promise<BenchScenario> {
  const data = await ensureLocomoDataset();
  const item = data[options.index];
  if (!item) {
    throw new Error(`LoCoMo index ${options.index} out of range (0-${data.length - 1}).`);
  }
  return locomoToScenario(item, options);
}

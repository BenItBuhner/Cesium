/** Debug helper: dump a strategy's final assembled context for one scenario. */
import { allScenarios } from "./scenarios.js";
import { resolveStrategies } from "./strategies.js";
import { makeBenchCaller } from "./model-client.js";
import type { AgentStoredEvent } from "../../src/lib/agents/types.js";

function turnBatches(events: AgentStoredEvent[]): AgentStoredEvent[][] {
  const batches: AgentStoredEvent[][] = [];
  let current: AgentStoredEvent[] = [];
  for (const event of events) {
    if (event.kind === "user_message" && current.length > 0) {
      batches.push(current);
      current = [];
    }
    current.push(event);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

const scenarioId = process.argv[2] ?? "fact-thread";
const strategyId = process.argv[3] ?? "cesium-ledger@0.35";
const window = Number(process.argv[4] ?? 16_000);
const compactorModel = process.argv[5] ?? "turbo";

const scenario = allScenarios().find((candidate) => candidate.id === scenarioId)!;
const strategy = resolveStrategies(strategyId)[0]!;
const run = strategy.createRun({ windowTokens: window, callModel: makeBenchCaller(compactorModel) });
for (const batch of turnBatches(scenario.events)) {
  await run.feed(batch);
}
const { messages, stats } = await run.finalize();
console.log("STATS", JSON.stringify(stats));
const events = (run as unknown as { debugEvents?: AgentStoredEvent[] }).debugEvents;
if (events) {
  const summaries = events.filter((event) => event.kind === "compression_summary");
  console.log(
    "EVENTS", events.length,
    "summaries:", JSON.stringify(
      summaries.map((event) =>
        event.kind === "compression_summary"
          ? { seq: event.seq, gen: event.generation, covered: event.sourceRange, len: event.summary.length }
          : null
      )
    )
  );
}
for (const message of messages) {
  console.log(`\n────────── ${message.role} ──────────`);
  console.log(message.content.slice(0, 6_000));
}

/**
 * Live smoke: execute a Cesium Workflow script using the AGENTS.md inference proxy.
 * Run: bun ./scripts/workflow-mode-live-smoke.ts
 */
import { executeWorkflowRun } from "../src/lib/agents/workflow-runtime.js";
import {
  createWorkflowRunRecord,
  upsertWorkflowRun,
} from "../src/lib/agents/workflow-store.js";
import {
  resolveCesiumAuth,
  upsertCesiumProviderKey,
  getCesiumAgentSettings,
  saveCesiumAgentSettings,
} from "../src/lib/cesium-agent-settings.js";
import { runAdapter } from "../src/lib/agents/cesium/cesium-model-adapters.js";
import { CESIUM_SYSTEM_PROMPT } from "../src/lib/agents/cesium/cesium-prompt.js";
import type { WorkspaceRecord } from "../src/lib/workspace-registry.js";

const BASE_URL = "https://infer.techlitnow.com/v1";
const MODEL = "openai/glm-5.2";

const SCRIPT = `export const meta = {
  name: "live-smoke",
  description: "Tiny fan-out then synthesize with the live model",
  phases: [
    { title: "Fanout", detail: "two short agents" },
    { title: "Synth", detail: "merge answers" },
  ],
};

phase("Fanout");
const parts = await parallel([
  () => agent("In one short sentence, what is 2+2?", { label: "math", phase: "Fanout" }),
  () => agent("In one short sentence, name the color of the sky on a clear day.", { label: "sky", phase: "Fanout" }),
]);
phase("Synth");
const merged = await agent(
  "Combine these two answers into one short sentence:\\n1) " + parts[0] + "\\n2) " + parts[1],
  { label: "synth", phase: "Synth" }
);
return { parts, merged };
`;

async function main() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for the live workflow smoke.");
  }

  await upsertCesiumProviderKey({
    apiKind: "openai-compatible",
    apiKey,
    baseUrl: BASE_URL,
    providerId: "openai",
  });
  const settings = await getCesiumAgentSettings();
  await saveCesiumAgentSettings({
    ...settings,
    defaultModelId: MODEL,
    defaultApiKind: "openai-compatible",
  });

  const workspace: WorkspaceRecord = {
    id: "ws-workflow-live",
    root: process.cwd(),
    name: "Workflow live smoke",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastOpenedAt: Date.now(),
  };

  let run = createWorkflowRunRecord({
    workspace,
    conversationId: "conv-workflow-live",
    script: SCRIPT,
    scriptPath: "/tmp/cesium-workflow-live-smoke.js",
    maxAgents: 8,
    maxConcurrent: 2,
  });
  run = await upsertWorkflowRun(run);

  const completed = await executeWorkflowRun({
    run,
    spawnAgent: async (request) => {
      const auth = await resolveCesiumAuth({
        modelId: MODEL,
        configuredApiKind: "openai-compatible",
      });
      const result = await runAdapter({
        apiKind: auth.apiKind,
        apiKey: auth.apiKey,
        baseUrl: auth.baseUrl,
        providerId: auth.providerId,
        modelId: MODEL,
        messages: [
          {
            role: "system",
            content: `${CESIUM_SYSTEM_PROMPT}\n\nYou are a workflow subagent. Reply briefly. Your final text is the agent() return value.`,
          },
          { role: "user", content: request.prompt },
        ],
      });
      return { value: result.text.trim(), tokensUsed: 50 };
    },
  });

  console.log(
    JSON.stringify(
      {
        status: completed.status,
        error: completed.error,
        agentsUsed: completed.agentsUsed,
        returnValue: completed.returnValue,
        agentLabels: completed.agents.map((agent) => `${agent.label}:${agent.status}`),
      },
      null,
      2
    )
  );

  if (completed.status !== "completed") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

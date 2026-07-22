import { asString } from "./json-coerce.js";
import type { OpenCodeV2Json } from "./opencode-v2-client.js";
import type { AgentConfigOption } from "./types.js";

export function buildOpenCodeV2ConfigOptions(input: {
  agents: OpenCodeV2Json[];
  models: OpenCodeV2Json[];
  currentAgent?: string;
  currentModel?: string;
  previous?: AgentConfigOption[];
}): AgentConfigOption[] {
  const reportedAgents = input.agents.flatMap((agent) => {
    const id = asString(agent.id);
    const mode = asString(agent.mode);
    if (!id || agent.hidden === true || mode === "subagent") return [];
    return [
      {
        value: id,
        name: asString(agent.name) ?? id,
        ...(asString(agent.description) ? { description: asString(agent.description) } : {}),
      },
    ];
  });
  const reportedModels = input.models.flatMap((model) => {
    const providerId = asString(model.providerID);
    const id = asString(model.id) ?? asString(model.modelID);
    if (!providerId || !id || model.enabled === false) return [];
    const name = asString(model.name) ?? id;
    const base = { value: `${providerId}/${id}`, name: `${providerId}/${name}` };
    const variants = Array.isArray(model.variants)
      ? model.variants.flatMap((variant) => {
          const variantId =
            variant && typeof variant === "object" && !Array.isArray(variant)
              ? asString((variant as OpenCodeV2Json).id)
              : undefined;
          return variantId
            ? [{ value: `${providerId}/${id}#${variantId}`, name: `${providerId}/${name} (${variantId})` }]
            : [];
        })
      : [];
    return [base, ...variants];
  });
  const previousAgent = input.previous?.find((option) => option.id === "agent" || option.id === "mode");
  const previousModel = input.previous?.find((option) => option.id === "model");
  const agents = reportedAgents.length > 0 ? reportedAgents : previousAgent?.options ?? [];
  const models = reportedModels.length > 0 ? reportedModels : previousModel?.options ?? [];
  const requestedAgent = input.currentAgent ?? previousAgent?.currentValue;
  const requestedModel = input.currentModel ?? previousModel?.currentValue;
  return [
    {
      id: "agent",
      name: "Agent",
      category: "mode",
      currentValue:
        requestedAgent && agents.some((option) => option.value === requestedAgent)
          ? requestedAgent
          : agents[0]?.value ?? "__default__",
      description: "Primary agents reported by the OpenCode v2 server.",
      options: agents,
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      currentValue:
        requestedModel && models.some((option) => option.value === requestedModel)
          ? requestedModel
          : models[0]?.value ?? "auto",
      description:
        models.length > 0
          ? "Models and variants reported by the OpenCode v2 server."
          : "No OpenCode v2 models were reported. Configure provider credentials in OpenCode.",
      options: models,
    },
  ];
}

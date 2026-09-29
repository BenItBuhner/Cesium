import { type CesiumTriggerSchedule, attachCesiumTriggerConversation, createCesiumTrigger, deleteCesiumTrigger, formatCesiumTrigger, formatTriggerPromptPreamble, listCesiumTriggers, markCesiumTriggerFired, normalizeTriggerSchedule, updateCesiumTrigger } from "../../cesium-triggers.js";
import { asNumber } from "../../json-coerce.js";
import { asString } from "../cesium-coerce.js";
import type { CesiumToolContext } from "./types.js";

/** Scheduled triggers: the agent's proactive wake-ups (cron/interval/once). */
export async function scheduleTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>): Promise<string> {
  const action = asString(args.action)?.trim().toLowerCase();
  const workspaceId = ctx.workspace.id;
  const parseScheduleArgs = (): CesiumTriggerSchedule => {
    const cron = asString(args.cron)?.trim();
    const everyMinutes = asNumber(args.everyMinutes);
    const atMs = asNumber(args.atMs);
    const provided = [cron, everyMinutes, atMs].filter(
      (value) => value !== undefined && value !== null && value !== ""
    );
    if (provided.length !== 1) {
      throw new Error(
        "Provide exactly one of schedule.cron, schedule.everyMinutes, or schedule.atMs."
      );
    }
    if (cron) {
      return normalizeTriggerSchedule({ kind: "cron", expression: cron });
    }
    if (everyMinutes != null) {
      return normalizeTriggerSchedule({ kind: "interval", everyMs: everyMinutes * 60_000 });
    }
    return normalizeTriggerSchedule({ kind: "once", atMs: atMs! });
  };
  switch (action) {
    case "create": {
      const name = asString(args.name)?.trim();
      const prompt = asString(args.prompt)?.trim();
      if (!name || !prompt) {
        throw new Error("schedule.create requires name and prompt.");
      }
      const trigger = await createCesiumTrigger({
        workspaceId,
        name,
        prompt,
        schedule: parseScheduleArgs(),
        mode: asString(args.mode)?.trim() || undefined,
        // Pin the creating conversation's model so scheduled fires never
        // fall back to an unconfigured provider default.
        modelId: ctx.conversation.config.modelId || undefined,
        modelName: ctx.conversation.config.modelName || undefined,
        maxRuns: asNumber(args.maxRuns) ?? undefined,
        sourceConversationId: ctx.conversationId,
      });
      return `Created trigger.\n${formatCesiumTrigger(trigger)}`;
    }
    case "list": {
      const triggers = await listCesiumTriggers(workspaceId);
      if (triggers.length === 0) {
        return "No scheduled triggers in this workspace. Use schedule create to add one.";
      }
      return [
        `${triggers.length} trigger${triggers.length === 1 ? "" : "s"}:`,
        ...triggers.map((trigger) => formatCesiumTrigger(trigger)),
      ].join("\n");
    }
    case "update": {
      const id = asString(args.id)?.trim();
      if (!id) {
        throw new Error("schedule.id is required for update.");
      }
      const hasScheduleInput =
        asString(args.cron)?.trim() || asNumber(args.everyMinutes) != null || asNumber(args.atMs) != null;
      const updated = await updateCesiumTrigger({
        workspaceId,
        id,
        patch: {
          ...(asString(args.name)?.trim() ? { name: asString(args.name)!.trim() } : {}),
          ...(asString(args.prompt)?.trim() ? { prompt: asString(args.prompt)!.trim() } : {}),
          ...(asString(args.mode) !== undefined ? { mode: asString(args.mode)?.trim() } : {}),
          ...(asNumber(args.maxRuns) != null ? { maxRuns: asNumber(args.maxRuns)! } : {}),
          ...(hasScheduleInput ? { schedule: parseScheduleArgs() } : {}),
        },
      });
      return `Updated trigger.\n${formatCesiumTrigger(updated)}`;
    }
    case "pause":
    case "resume": {
      const id = asString(args.id)?.trim();
      if (!id) {
        throw new Error(`schedule.id is required for ${action}.`);
      }
      const updated = await updateCesiumTrigger({
        workspaceId,
        id,
        patch: { enabled: action === "resume" },
      });
      return `${action === "resume" ? "Resumed" : "Paused"} trigger.\n${formatCesiumTrigger(updated)}`;
    }
    case "delete": {
      const id = asString(args.id)?.trim();
      if (!id) {
        throw new Error("schedule.id is required for delete.");
      }
      const removed = await deleteCesiumTrigger({ workspaceId, id });
      if (!removed) {
        return `No trigger with id ${id}. Use schedule list to see current triggers.`;
      }
      return `Deleted trigger "${removed.name}" (id: ${removed.id}).`;
    }
    case "run": {
      const id = asString(args.id)?.trim();
      if (!id) {
        throw new Error("schedule.id is required for run.");
      }
      const triggers = await listCesiumTriggers(workspaceId);
      const trigger = triggers.find((entry) => entry.id === id);
      if (!trigger) {
        return `No trigger with id ${id}. Use schedule list to see current triggers.`;
      }
      const firedAt = Date.now();
      const marked = await markCesiumTriggerFired({ workspaceId, id, firedAt });
      const { agentRuntimeManager } = await import("../../runtime-manager.js");
      const snapshot = await agentRuntimeManager.createConversationWithPrompt(
        ctx.workspace,
        {
          backendId: "cesium-agent",
          ...(trigger.mode ? { mode: trigger.mode } : {}),
          ...(trigger.modelId ? { modelId: trigger.modelId } : {}),
          ...(trigger.modelName ? { modelName: trigger.modelName } : {}),
          title: `⏰ ${trigger.name}`,
          origin: {
            kind: "trigger",
            triggerId: trigger.id,
            triggerName: trigger.name,
            firedAt,
          },
        },
        { text: formatTriggerPromptPreamble(trigger, firedAt) }
      );
      await attachCesiumTriggerConversation({
        workspaceId,
        id,
        conversationId: snapshot.conversation.id,
      }).catch(() => null);
      return (
        `Fired trigger "${trigger.name}" now -> conversation ${snapshot.conversation.id}.` +
        (marked && !marked.enabled ? " The trigger is now disabled (run cap reached)." : "")
      );
    }
    default:
      throw new Error(
        'schedule.action must be one of "create", "list", "update", "pause", "resume", "delete", "run".'
      );
  }
}

import { listWorkspaces } from "../workspace-registry.js";
import { agentRuntimeManager } from "./runtime-manager.js";
import {
  attachCesiumTriggerConversation,
  formatTriggerPromptPreamble,
  listCesiumTriggers,
  markCesiumTriggerFired,
  type CesiumAgentTrigger,
} from "./cesium-triggers.js";

/**
 * The trigger scheduler: a light tick loop that fires due Cesium agent
 * triggers by spawning a fresh conversation per fire.
 *
 * Reliability model: `markCesiumTriggerFired` persists run bookkeeping BEFORE
 * the conversation is prompted, so a crash mid-fire skips (never doubles) a
 * run. Overdue triggers (server was down) fire once and re-arm from now — no
 * catch-up storms.
 */

export const CESIUM_TRIGGER_TICK_MS = 30_000;

let tickTimer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

async function fireTrigger(
  workspace: Awaited<ReturnType<typeof listWorkspaces>>[number],
  trigger: CesiumAgentTrigger,
  now: number
): Promise<void> {
  // Persist bookkeeping first (crash safety), then prompt.
  const marked = await markCesiumTriggerFired({
    workspaceId: workspace.id,
    id: trigger.id,
    firedAt: now,
  });
  if (!marked) {
    return;
  }
  const snapshot = await agentRuntimeManager.createConversationWithPrompt(
    workspace,
    {
      backendId: "cesium-agent",
      ...(trigger.mode ? { mode: trigger.mode } : {}),
      ...(trigger.profileId ? { profileId: trigger.profileId } : {}),
      ...(trigger.modelId ? { modelId: trigger.modelId } : {}),
      ...(trigger.modelName ? { modelName: trigger.modelName } : {}),
      title: `⏰ ${trigger.name}`,
      origin: {
        kind: "trigger",
        triggerId: trigger.id,
        triggerName: trigger.name,
        firedAt: now,
      },
    },
    { text: formatTriggerPromptPreamble(trigger, now) }
  );
  await attachCesiumTriggerConversation({
    workspaceId: workspace.id,
    id: trigger.id,
    conversationId: snapshot.conversation.id,
  }).catch(() => null);
  console.log(
    `[triggers] fired "${trigger.name}" (${trigger.id}) -> conversation ${snapshot.conversation.id}`
  );
}

/** One scheduler pass over every workspace. Exported for tests and run-now. */
export async function runCesiumTriggerTick(nowMs: number = Date.now()): Promise<number> {
  let fired = 0;
  const workspaces = await listWorkspaces().catch(() => []);
  for (const workspace of workspaces) {
    const triggers = await listCesiumTriggers(workspace.id).catch(() => []);
    for (const trigger of triggers) {
      if (!trigger.enabled || trigger.nextRunAt == null || trigger.nextRunAt > nowMs) {
        continue;
      }
      try {
        await fireTrigger(workspace, trigger, nowMs);
        fired += 1;
      } catch (error) {
        console.error(
          `[triggers] failed to fire "${trigger.name}" (${trigger.id}):`,
          error
        );
      }
    }
  }
  return fired;
}

export function startCesiumTriggerScheduler(): void {
  if (tickTimer) {
    return;
  }
  tickTimer = setInterval(() => {
    if (ticking) {
      return;
    }
    ticking = true;
    void runCesiumTriggerTick()
      .catch((error) => {
        console.error("[triggers] scheduler tick failed:", error);
      })
      .finally(() => {
        ticking = false;
      });
  }, CESIUM_TRIGGER_TICK_MS);
  // Do not hold the process open just for the scheduler.
  if (typeof tickTimer === "object" && tickTimer && "unref" in tickTimer) {
    (tickTimer as { unref(): void }).unref();
  }
  console.log(`[triggers] scheduler started (tick every ${CESIUM_TRIGGER_TICK_MS / 1000}s).`);
}

export function stopCesiumTriggerScheduler(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

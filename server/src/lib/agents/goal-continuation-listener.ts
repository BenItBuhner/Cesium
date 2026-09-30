import { getWorkspaceById } from "../workspace-registry.js";
import { agentRuntimeManager } from "./runtime-manager.js";
import { subscribeAgentStoreEvents } from "./session-store.js";

const inFlight = new Set<string>();
const checkedSeq = new Map<string, number>();

/** When a Cesium conversation goes idle with nothing queued, lets an active Goal continue (see `continueGoalIfRunnable`). */
export function startGoalContinuationListener(): void {
  subscribeAgentStoreEvents((event) => {
    if (event.type !== "conversation") {
      return;
    }
    const c = event.conversation;
    if (
      c.config.backendId !== "cesium-agent" ||
      c.status !== "idle" ||
      (c.queuedPrompts?.length ?? 0) > 0 ||
      checkedSeq.get(c.id) === c.lastEventSeq ||
      inFlight.has(c.id)
    ) {
      return;
    }
    checkedSeq.set(c.id, c.lastEventSeq);
    setImmediate(() => {
      void (async () => {
        if (inFlight.has(c.id)) {
          return;
        }
        inFlight.add(c.id);
        try {
          const workspace = await getWorkspaceById(c.workspaceId);
          if (workspace) {
            await agentRuntimeManager.continueGoalIfRunnable(workspace, c.id);
          }
        } catch (error) {
          console.warn("[goal] continuing the Goal failed:", error instanceof Error ? error.message : error);
        } finally {
          inFlight.delete(c.id);
        }
      })();
    });
  });
}

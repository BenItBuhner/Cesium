import { getWorkspaceById } from "../workspace-registry.js";
import { agentRuntimeManager } from "./runtime-manager.js";
import { subscribeAgentStoreEvents } from "./session-store.js";

const inFlight = new Set<string>();

/** When a conversation is idle and has a server-side queue, start the next turn. */
export function startAgentPromptQueueDrainListener(): void {
  subscribeAgentStoreEvents((event) => {
    if (event.type !== "conversation") {
      return;
    }
    const c = event.conversation;
    if (c.status !== "idle" || !c.queuedPrompts?.length) {
      return;
    }
    if (inFlight.has(c.id)) {
      return;
    }
    setImmediate(() => {
      void (async () => {
        if (inFlight.has(c.id)) {
          return;
        }
        inFlight.add(c.id);
        try {
          const workspace = await getWorkspaceById(c.workspaceId);
          if (!workspace) {
            return;
          }
          await agentRuntimeManager.drainOneQueuedPrompt(workspace, c.id);
        } finally {
          inFlight.delete(c.id);
        }
      })();
    });
  });
}

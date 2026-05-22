import {
  getMobileNotificationChip,
  isMobileAgentRunActive,
  type MobileAgentProjection,
} from "../../../../src/lib/mobile-agent-projection";
import { CesiumLiveUpdates } from "../native/CesiumLiveUpdates";
import type { LiveUpdatePayload, LiveUpdateStatus } from "./liveUpdateTypes";

export class LiveUpdateController {
  private lastProjection: MobileAgentProjection | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private status: LiveUpdateStatus | null = null;

  async update(projection: MobileAgentProjection | null) {
    this.lastProjection = projection;
    if (!projection) {
      await this.stop();
      return;
    }

    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }

    const payload = toLiveUpdatePayload(projection);
    this.status = await CesiumLiveUpdates.startOrUpdate(payload);

    if (!isMobileAgentRunActive(projection.status)) {
      this.stopTimer = setTimeout(() => {
        void this.stop();
      }, 15000);
    }
  }

  async refreshStatus() {
    this.status = await CesiumLiveUpdates.getPromotionStatus();
    return this.status;
  }

  getLastProjection() {
    return this.lastProjection;
  }

  getStatus() {
    return this.status;
  }

  async stop() {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    await CesiumLiveUpdates.stop();
  }
}

export function toLiveUpdatePayload(projection: MobileAgentProjection): LiveUpdatePayload {
  const active = isMobileAgentRunActive(projection.status);
  return {
    title: projection.title || "Cesium agent",
    body: projection.currentActivity || "Agent is working",
    shortText: getMobileNotificationChip(projection.status),
    workspaceId: projection.workspaceId,
    conversationId: projection.conversationId,
    startedAt: projection.startedAt,
    progress: projection.status === "completed" ? 100 : active ? 50 : 0,
    progressMax: 100,
    indeterminate: active,
    intervention: projection.pendingIntervention,
    ongoing: active,
    cancellable: active,
  };
}

import {
  isMobileAgentRunActive,
  type MobileAgentProjection,
} from "@cesium/core";
import { CesiumLiveUpdates } from "../native/CesiumLiveUpdates";
import { toLiveUpdatePayload } from "./liveUpdateProjection";
import type { LiveUpdateStatus } from "./liveUpdateTypes";

export { toLiveUpdatePayload } from "./liveUpdateProjection";

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

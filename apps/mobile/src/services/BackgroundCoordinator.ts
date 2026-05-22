import type { AppStateStatus } from "react-native";
import type { AgentStatusService } from "./AgentStatusService";
import type { LiveUpdateController } from "./LiveUpdateController";

export class BackgroundCoordinator {
  private appState: AppStateStatus = "active";
  private networkReachable = true;

  constructor(
    private readonly agentStatus: AgentStatusService,
    private readonly liveUpdates: LiveUpdateController
  ) {}

  setAppState(nextState: AppStateStatus) {
    this.appState = nextState;
    if (nextState === "active") {
      this.agentStatus.connect();
      void this.liveUpdates.refreshStatus();
    }
  }

  setNetworkReachable(reachable: boolean | null) {
    this.networkReachable = reachable !== false;
    if (this.networkReachable && this.appState === "active") {
      this.agentStatus.connect();
    }
  }

  shouldKeepFocusedAgentSocketAlive() {
    return this.networkReachable;
  }
}

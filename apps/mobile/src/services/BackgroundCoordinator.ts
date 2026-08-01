import type { AppStateStatus } from "react-native";
import type { AgentStatusService } from "./AgentStatusService";
import type { LiveUpdateController } from "./LiveUpdateController";

type BackgroundAgentStatus = Pick<
  AgentStatusService,
  "setConnectionEnabled"
>;

type BackgroundLiveUpdates = Pick<LiveUpdateController, "refreshStatus">;

export class BackgroundCoordinator {
  private appState: AppStateStatus = "active";
  private networkReachable = true;

  constructor(
    private readonly agentStatus: BackgroundAgentStatus,
    private readonly liveUpdates: BackgroundLiveUpdates
  ) {}

  setAppState(nextState: AppStateStatus) {
    this.appState = nextState;
    this.syncAgentConnection();
    if (nextState === "active") {
      void this.liveUpdates.refreshStatus();
    }
  }

  setNetworkReachable(reachable: boolean | null) {
    this.networkReachable = reachable !== false;
    this.syncAgentConnection();
  }

  shouldKeepFocusedAgentSocketAlive() {
    return this.networkReachable && this.appState !== "active";
  }

  private syncAgentConnection() {
    this.agentStatus.setConnectionEnabled(
      this.shouldKeepFocusedAgentSocketAlive()
    );
  }
}

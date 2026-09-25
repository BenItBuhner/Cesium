import type { ProjectAgentDelivery } from "@cesium/core/projects";
import {
  MISSING_CHILD_OBSERVATION,
  type ChildCreateInput,
  type ChildCreateResult,
  type ChildHost,
  type ChildObservation,
  type ChildRef,
  type ChildTurnDigest,
  type ChildUpdatePatch,
} from "./child-host.js";
import { callPeerEngine } from "./engine-registry.js";
import { ProjectError } from "./errors.js";
import { PeerRequestError } from "./peer-client.js";

/** Children hosted by a peer engine, driven over its peer API. */
export class RemoteChildHost implements ChildHost {
  constructor(readonly engineId: string) {}

  async create(input: ChildCreateInput): Promise<ChildCreateResult> {
    const { peerTokenId: _peerTokenId, placement, ...rest } = input;
    if (placement.kind === "root") {
      throw new ProjectError("Remote agents are placed by workspace id or in a scratch folder.");
    }
    try {
      return await callPeerEngine(this.engineId, (client) =>
        client.createChild({ ...rest, placement })
      );
    } catch (error) {
      if (error instanceof PeerRequestError && error.status >= 400 && error.status < 500) {
        throw new ProjectError(error.message, 400, error.code);
      }
      throw error;
    }
  }

  async observe(ref: ChildRef): Promise<ChildObservation> {
    try {
      return await callPeerEngine(this.engineId, (client) => client.observe(ref));
    } catch (error) {
      if (error instanceof PeerRequestError && error.status === 404) {
        return MISSING_CHILD_OBSERVATION;
      }
      throw error;
    }
  }

  digestSince(ref: ChildRef, afterSeq: number, throughSeq: number): Promise<ChildTurnDigest> {
    return callPeerEngine(this.engineId, (client) => client.digest(ref, afterSeq, throughSeq));
  }

  transcript(ref: ChildRef, turns: number): Promise<string> {
    return callPeerEngine(this.engineId, (client) => client.transcript(ref, turns));
  }

  message(ref: ChildRef, text: string, delivery: "steer" | "queue"): Promise<ProjectAgentDelivery> {
    return callPeerEngine(this.engineId, (client) => client.message(ref, text, delivery));
  }

  stop(ref: ChildRef): Promise<void> {
    return callPeerEngine(this.engineId, (client) => client.stop(ref));
  }

  update(ref: ChildRef, patch: ChildUpdatePatch): Promise<void> {
    return callPeerEngine(this.engineId, (client) => client.update(ref, patch));
  }

  async delete(ref: ChildRef): Promise<void> {
    try {
      await callPeerEngine(this.engineId, (client) => client.delete(ref));
    } catch (error) {
      if (error instanceof PeerRequestError && error.status === 404) {
        return;
      }
      throw error;
    }
  }
}

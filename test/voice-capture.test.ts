import test from "node:test";
import assert from "node:assert/strict";
import { VoiceCapture } from "../src/lib/voice/capture.ts";

type MockTrack = {
  label: string;
  stop: () => void;
  getSettings: () => {
    sampleRate: number;
    echoCancellation: boolean;
    noiseSuppression: boolean;
    autoGainControl: boolean;
  };
  stopped: boolean;
};

function createTrack(): MockTrack {
  const track: MockTrack = {
    label: "Fake Mic",
    stopped: false,
    stop() {
      track.stopped = true;
    },
    getSettings: () => ({
      sampleRate: 48000,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    }),
  };
  return track;
}

function installCaptureMocks(options: {
  grantStream: () => Promise<{ track: MockTrack }>;
}): () => void {
  const previous = {
    navigator: (globalThis as { navigator?: unknown }).navigator,
    AudioContext: (globalThis as { AudioContext?: unknown }).AudioContext,
    AudioWorkletNode: (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode,
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL,
  };

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => {
          const { track } = await options.grantStream();
          return {
            getTracks: () => [track],
            getAudioTracks: () => [track],
          };
        },
      },
    },
  });

  (globalThis as { AudioContext: unknown }).AudioContext = class MockAudioContext {
    sampleRate = 48000;
    state = "running";
    audioWorklet = {
      addModule: async () => {},
    };
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    async resume() {}
    async close() {}
  };

  (globalThis as { AudioWorkletNode: unknown }).AudioWorkletNode = class MockWorklet {
    port = { onmessage: null, close() {} };
    disconnect() {}
  };

  URL.createObjectURL = () => "blob:voice-capture-test";
  URL.revokeObjectURL = () => {};

  return () => {
    if (previous.navigator === undefined) {
      delete (globalThis as { navigator?: unknown }).navigator;
    } else {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: previous.navigator,
      });
    }
    if (previous.AudioContext === undefined) {
      delete (globalThis as { AudioContext?: unknown }).AudioContext;
    } else {
      (globalThis as { AudioContext: unknown }).AudioContext = previous.AudioContext;
    }
    if (previous.AudioWorkletNode === undefined) {
      delete (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode;
    } else {
      (globalThis as { AudioWorkletNode: unknown }).AudioWorkletNode =
        previous.AudioWorkletNode;
    }
    URL.createObjectURL = previous.createObjectURL;
    URL.revokeObjectURL = previous.revokeObjectURL;
  };
}

test("stop during getUserMedia releases the track once it arrives", async () => {
  let grant!: (value: { track: MockTrack }) => void;
  const pending = new Promise<{ track: MockTrack }>((resolve) => {
    grant = resolve;
  });
  const restore = installCaptureMocks({ grantStream: () => pending });
  try {
    const capture = new VoiceCapture({ onFrame: () => {} });
    const started = capture.start();
    await capture.stop();
    const track = createTrack();
    grant({ track });
    await started;
    assert.equal(capture.isRunning, false);
    assert.equal(track.stopped, true);
  } finally {
    restore();
  }
});

test("a completed start keeps the track until stop", async () => {
  const track = createTrack();
  const restore = installCaptureMocks({
    grantStream: async () => ({ track }),
  });
  try {
    const capture = new VoiceCapture({ onFrame: () => {} });
    await capture.start();
    assert.equal(capture.isRunning, true);
    assert.equal(track.stopped, false);
    await capture.stop();
    assert.equal(capture.isRunning, false);
    assert.equal(track.stopped, true);
  } finally {
    restore();
  }
});

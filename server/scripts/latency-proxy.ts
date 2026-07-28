/**
 * TCP latency/loss proxy for testing Cesium under terrible networks.
 *
 * Sits between the Next.js frontend and the Bun backend and injects
 * configurable one-way delay, jitter, and periodic connection drops into
 * every proxied connection (HTTP and WebSocket alike).
 *
 * Usage:
 *   bun server/scripts/latency-proxy.ts            # listens on 9101 -> 9100
 *   LISTEN_PORT=9101 TARGET_PORT=9100 DELAY_MS=500 JITTER_MS=200 DROP_EVERY_SEC=20 \
 *     bun server/scripts/latency-proxy.ts
 *
 * Live control (re-read every second, overrides env):
 *   echo '{"delayMs":750,"jitterMs":250,"dropEverySec":15}' > /tmp/cesium-latency-proxy.json
 *
 * Point the frontend at the proxy with NEXT_PUBLIC_SERVER_URL=http://localhost:9101.
 */
import net from "node:net";
import { readFileSync } from "node:fs";

const LISTEN_PORT = Number.parseInt(process.env.LISTEN_PORT ?? "9101", 10);
const TARGET_PORT = Number.parseInt(process.env.TARGET_PORT ?? "9100", 10);
const TARGET_HOST = process.env.TARGET_HOST ?? "127.0.0.1";
const CONTROL_FILE = process.env.CONTROL_FILE ?? "/tmp/cesium-latency-proxy.json";

type ProxyConfig = {
  delayMs: number;
  jitterMs: number;
  dropEverySec: number;
};

let config: ProxyConfig = {
  delayMs: Number.parseInt(process.env.DELAY_MS ?? "0", 10) || 0,
  jitterMs: Number.parseInt(process.env.JITTER_MS ?? "0", 10) || 0,
  dropEverySec: Number.parseInt(process.env.DROP_EVERY_SEC ?? "0", 10) || 0,
};

function refreshConfig(): void {
  try {
    const raw = JSON.parse(readFileSync(CONTROL_FILE, "utf8")) as Partial<ProxyConfig>;
    const next: ProxyConfig = {
      delayMs: typeof raw.delayMs === "number" ? raw.delayMs : config.delayMs,
      jitterMs: typeof raw.jitterMs === "number" ? raw.jitterMs : config.jitterMs,
      dropEverySec: typeof raw.dropEverySec === "number" ? raw.dropEverySec : config.dropEverySec,
    };
    if (
      next.delayMs !== config.delayMs ||
      next.jitterMs !== config.jitterMs ||
      next.dropEverySec !== config.dropEverySec
    ) {
      config = next;
      console.log(
        `[latency-proxy] config: delay=${config.delayMs}ms jitter=${config.jitterMs}ms dropEvery=${config.dropEverySec}s`
      );
    }
  } catch {
    /* control file absent -> keep current config */
  }
}

setInterval(refreshConfig, 1_000).unref();
refreshConfig();

function currentDelay(): number {
  return Math.max(0, config.delayMs + (Math.random() * 2 - 1) * config.jitterMs);
}

let connectionCounter = 0;

const server = net.createServer((client) => {
  connectionCounter += 1;
  const id = connectionCounter;
  const upstream = net.connect(TARGET_PORT, TARGET_HOST);
  let closed = false;

  const close = (reason: string) => {
    if (closed) return;
    closed = true;
    client.destroy();
    upstream.destroy();
    if (config.dropEverySec > 0) {
      console.log(`[latency-proxy] #${id} closed (${reason})`);
    }
  };

  const forward = (from: net.Socket, to: net.Socket) => {
    from.on("data", (chunk) => {
      const delay = currentDelay();
      if (delay <= 0) {
        if (!closed) to.write(chunk);
        return;
      }
      setTimeout(() => {
        if (!closed && to.writable) to.write(chunk);
      }, delay);
    });
    from.on("end", () => {
      const delay = currentDelay();
      setTimeout(() => {
        if (!closed && to.writable) to.end();
      }, delay);
    });
    from.on("error", () => close("error"));
  };

  forward(client, upstream);
  forward(upstream, client);
  upstream.on("connect", () => {
    if (config.dropEverySec > 0) {
      const lifetime = (0.5 + Math.random()) * config.dropEverySec * 1_000;
      setTimeout(() => close("simulated drop"), lifetime);
    }
  });
  client.on("close", () => close("client close"));
  upstream.on("close", () => close("upstream close"));
});

server.listen(LISTEN_PORT, () => {
  console.log(
    `[latency-proxy] listening on :${LISTEN_PORT} -> ${TARGET_HOST}:${TARGET_PORT} ` +
      `(delay=${config.delayMs}ms jitter=${config.jitterMs}ms dropEvery=${config.dropEverySec}s)`
  );
});

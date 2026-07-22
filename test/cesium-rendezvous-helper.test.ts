import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { after, before, describe, test } from "node:test";
import {
  decodeRendezvousBootstrap,
  decryptRendezvousCiphertext,
} from "../packages/client/src/rendezvous.ts";

const run = promisify(execFile);
const SERVER_ID = "server_1234567890abcdefghijklmnop";
const READ_SECRET = "read_secret_1234567890abcdefghijklmnopqrstuv";
const WRITE_SECRET = "write_secret_1234567890abcdefghijklmnopqrstu";
let registryBaseUrl = "";
let lastRequest:
  | { authorization: string | undefined; body: { version: number; ciphertext: string }; url: string }
  | null = null;

const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  request.on("end", () => {
    lastRequest = {
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        version: number;
        ciphertext: string;
      },
      url: request.url ?? "",
    };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"ok":true}');
  });
});

before(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start rendezvous test server.");
  }
  registryBaseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

function helperEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CESIUM_SERVER_ID: SERVER_ID,
    CESIUM_SERVER_LABEL: "Home server",
    CESIUM_RENDEZVOUS_READ_SECRET: READ_SECRET,
    CESIUM_RENDEZVOUS_WRITE_SECRET: WRITE_SECRET,
    CESIUM_RENDEZVOUS_URL: `${registryBaseUrl}/api/rendezvous`,
  };
}

describe("installed rendezvous helper", () => {
  test("publishes an authenticated encrypted endpoint", async () => {
    await run(
      process.execPath,
      [
        "scripts/cesium-rendezvous.mjs",
        "publish",
        "https://rotated-tunnel.example",
        "localhost-run",
      ],
      { cwd: process.cwd(), env: helperEnv() }
    );
    assert.ok(lastRequest);
    assert.equal(lastRequest.authorization, `Bearer ${WRITE_SECRET}`);
    assert.equal(lastRequest.url, `/api/rendezvous/${SERVER_ID}`);
    assert.equal(lastRequest.body.version, 1);
    const decrypted = await decryptRendezvousCiphertext(
      {
        version: 1,
        serverId: SERVER_ID,
        secret: READ_SECRET,
        registryBaseUrl,
      },
      lastRequest.body.ciphertext
    );
    assert.equal(decrypted.baseUrl, "https://rotated-tunnel.example");
    assert.equal(decrypted.label, "Home server");
    assert.equal(decrypted.tunnelProvider, "localhost-run");
  });

  test("prints a fragment-only stable connection identity", async () => {
    const { stdout } = await run(
      process.execPath,
      [
        "scripts/cesium-rendezvous.mjs",
        "connect-fragment",
        "https://first-tunnel.example",
      ],
      { cwd: process.cwd(), env: helperEnv() }
    );
    assert.deepEqual(decodeRendezvousBootstrap(stdout), {
      version: 1,
      serverId: SERVER_ID,
      secret: READ_SECRET,
      registryBaseUrl,
      initialBaseUrl: "https://first-tunnel.example",
      label: "Home server",
    });
  });
});

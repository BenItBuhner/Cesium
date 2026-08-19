import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import {
  describeProtocolNegotiation,
  selectPreferredProtocol,
} from "../src/lib/mcp/protocol.js";
import {
  createStatelessHttpMcpClient,
  parseMcpHttpResponse,
  probeSessionHttp,
  probeStatelessHttp,
} from "../src/lib/mcp/protocol-http.js";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function withMockServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    handler(req, res, body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected tcp address");
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

function json(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

test("selectPreferredProtocol prefers stateless when both probes succeed", () => {
  const negotiation = selectPreferredProtocol([
    { era: "stateless", version: "2026-07-28", ok: true },
    { era: "session", version: "2025-11-25", ok: true },
  ]);
  assert.equal(negotiation.selected, "stateless");
  assert.equal(negotiation.selectedVersion, "2026-07-28");
});

test("selectPreferredProtocol falls back to session when stateless is missing", () => {
  const negotiation = selectPreferredProtocol([
    { era: "stateless", version: "2026-07-28", ok: false, error: "no discover" },
    { era: "session", version: "2025-11-25", ok: true },
  ]);
  assert.equal(negotiation.selected, "session");
  assert.match(describeProtocolNegotiation(negotiation), /Session MCP 2025-11-25/);
});

test("HTTP probes choose stateless when the server speaks both dialects", async () => {
  const seen: string[] = [];
  const mock = await withMockServer((req, res, body) => {
    seen.push(String(body.method));
    if (body.method === "server/discover") {
      json(res, 200, {
        jsonrpc: "2.0",
        id: body.id,
        result: { protocolVersion: "2026-07-28", capabilities: { tools: {} } },
      });
      return;
    }
    if (body.method === "initialize") {
      json(res, 200, {
        jsonrpc: "2.0",
        id: body.id,
        result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } },
      });
      return;
    }
    json(res, 200, { jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "echo" }] } });
  });
  try {
    const [stateless, session] = await Promise.all([
      probeStatelessHttp(mock.url, {}),
      probeSessionHttp(mock.url, {}),
    ]);
    const negotiation = selectPreferredProtocol([stateless, session]);
    assert.equal(stateless.ok, true);
    assert.equal(session.ok, true);
    assert.equal(negotiation.selected, "stateless");
    assert.ok(seen.includes("server/discover"));
    assert.ok(seen.includes("initialize"));

    const client = createStatelessHttpMcpClient({ url: mock.url, headers: {} });
    const listed = await client.listTools();
    assert.equal(listed.tools[0]?.name, "echo");
  } finally {
    await mock.close();
  }
});

test("HTTP probes fall back to session when only initialize works", async () => {
  const mock = await withMockServer((req, res, body) => {
    if (body.method === "initialize") {
      json(res, 200, {
        jsonrpc: "2.0",
        id: body.id,
        result: { protocolVersion: "2025-11-25", capabilities: {} },
      });
      return;
    }
    json(res, 400, {
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32601, message: "Method not found" },
    });
  });
  try {
    const [stateless, session] = await Promise.all([
      probeStatelessHttp(mock.url, {}),
      probeSessionHttp(mock.url, {}),
    ]);
    const negotiation = selectPreferredProtocol([stateless, session]);
    assert.equal(stateless.ok, false);
    assert.equal(session.ok, true);
    assert.equal(negotiation.selected, "session");
  } finally {
    await mock.close();
  }
});

test("stateless HTTP client sends 2026 headers and per-request _meta", async () => {
  let lastHeaders: Record<string, string | string[] | undefined> = {};
  let lastBody: Record<string, unknown> = {};
  const mock = await withMockServer((req, res, body) => {
    lastHeaders = req.headers;
    lastBody = body;
    json(res, 200, {
      jsonrpc: "2.0",
      id: body.id,
      result: { content: [{ type: "text", text: "ok" }] },
    });
  });
  try {
    const client = createStatelessHttpMcpClient({ url: mock.url, headers: {} });
    await client.callTool({ name: "search", arguments: { q: "otters" } });
    assert.equal(lastHeaders["mcp-protocol-version"], "2026-07-28");
    assert.equal(lastHeaders["mcp-method"], "tools/call");
    assert.equal(lastHeaders["mcp-name"], "search");
    const params = lastBody.params as Record<string, unknown>;
    const meta = params._meta as Record<string, unknown>;
    assert.equal(meta["io.modelcontextprotocol/protocolVersion"], "2026-07-28");
  } finally {
    await mock.close();
  }
});

test("parseMcpHttpResponse reads the last SSE data frame", async () => {
  const response = new Response("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n\n", {
    headers: { "Content-Type": "text/event-stream" },
  });
  const payload = await parseMcpHttpResponse(response);
  assert.deepEqual(payload.result, { ok: true });
});

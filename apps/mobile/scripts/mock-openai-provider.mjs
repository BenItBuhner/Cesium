// Minimal OpenAI-compatible provider for CI smoke tests: always answers with a
// fixed passphrase so the full app pipeline (WebView -> Cesium server ->
// provider HTTP -> streamed events -> UI) can be asserted deterministically,
// without real credentials on the runner.
import http from "node:http";

const port = Number(process.env.PORT || 8123);
const reply = process.env.MOCK_REPLY || "Cesium iOS end-to-end PASS";

function json(res, payload, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function chunk(id, model, delta, finishReason) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (part) => (body += part));
    req.on("end", () => {
      const url = (req.url || "").split("?")[0];
      if (url.endsWith("/models")) {
        json(res, { object: "list", data: [{ id: "kimi-k3", object: "model" }] });
        return;
      }
      if (!url.endsWith("/chat/completions")) {
        json(res, { error: { message: `no mock for ${url}` } }, 404);
        return;
      }
      let stream = false;
      let model = "kimi-k3";
      try {
        const parsed = JSON.parse(body || "{}");
        stream = parsed.stream === true;
        if (typeof parsed.model === "string" && parsed.model) model = parsed.model;
      } catch {
        // Treat unparsable bodies as non-streaming requests.
      }
      const id = `chatcmpl-mock-${Date.now()}`;
      console.log(`[mock-openai] POST chat/completions model=${model} stream=${stream}`);
      if (!stream) {
        json(res, {
          id,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: reply },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
        });
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      for (const part of [
        chunk(id, model, { role: "assistant" }, null),
        chunk(id, model, { content: reply }, null),
        chunk(id, model, {}, "stop"),
      ]) {
        res.write(`data: ${JSON.stringify(part)}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  })
  .listen(port, "127.0.0.1", () => {
    console.log(`[mock-openai] listening on http://127.0.0.1:${port}`);
  });

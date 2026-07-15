import http from "node:http";

let quickHealthServer: http.Server | null = null;

function readServerPort(): number {
  return Number.parseInt(process.env.PORT ?? "9100", 10);
}

function readServerHost(): string {
  return process.env.HOST?.trim() || "127.0.0.1";
}

export function startDesktopQuickHealthListener(): Promise<void> {
  if (process.env.OPENCURSOR_DESKTOP_BACKEND !== "1") {
    return Promise.resolve();
  }
  if (quickHealthServer) {
    return Promise.resolve();
  }

  const port = readServerPort();
  const host = readServerHost();

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const pathname = req.url?.split("?", 1)[0] ?? "";
      if (pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, bootstrapping: true }));
        return;
      }
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("Cesium server is starting");
    });

    server.once("error", reject);
    server.listen(port, host, () => {
      quickHealthServer = server;
      console.log(
        `[desktop] quick health listening on http://${host}:${port}`
      );
      resolve();
    });
  });
}

export async function stopDesktopQuickHealthListener(): Promise<void> {
  const server = quickHealthServer;
  if (!server) {
    return;
  }
  quickHealthServer = null;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

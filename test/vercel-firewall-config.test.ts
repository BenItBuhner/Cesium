import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

describe("legacy rendezvous firewall gate", () => {
  test("denies unversioned legacy traffic before it reaches Vercel compute", async () => {
    const config = JSON.parse(
      await readFile(new URL("../vercel.json", import.meta.url), "utf8")
    ) as {
      routes?: Array<{
        src?: string;
        methods?: string[];
        missing?: Array<{ type?: string; key?: string; value?: string }>;
        mitigate?: { action?: string };
      }>;
    };
    assert.deepEqual(config.routes, [
      {
        src: "/api/rendezvous(?:/.*)?",
        methods: ["GET", "POST", "PUT"],
        missing: [
          {
            type: "header",
            key: "x-cesium-rendezvous-version",
            value: "2",
          },
        ],
        mitigate: { action: "deny" },
      },
    ]);
  });
});

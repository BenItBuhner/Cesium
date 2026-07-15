import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { materializeImageAttachments } from "../src/lib/agents/prompt-attachments.js";

test("materializeImageAttachments writes image data to temp files and cleans up", async () => {
  const payload = Buffer.from("hello image").toString("base64");
  const materialized = await materializeImageAttachments(
    [{ mimeType: "image/png", data: `data:image/png;base64,${payload}`, name: "shot.png" }],
    "test"
  );

  assert.equal(materialized.paths.length, 1);
  assert.equal(await readFile(materialized.paths[0]!, "utf8"), "hello image");
  await materialized.cleanup();
  await assert.rejects(readFile(materialized.paths[0]!, "utf8"));
});

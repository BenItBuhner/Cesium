import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { materializeImageAttachments } from "../src/lib/agents/prompt-attachments.js";
import {
  buildAttachmentsReminderText,
  FILE_UPLOADS_DIR,
} from "../src/lib/agents/attachment-reminders.js";

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

test("materializeImageAttachments skips generic file attachments without inline data", async () => {
  const materialized = await materializeImageAttachments(
    [
      {
        mimeType: "application/pdf",
        data: "",
        name: "report.pdf",
      },
      { mimeType: "image/png", data: "", name: "empty.png" },
    ],
    "test"
  );
  assert.equal(materialized.paths.length, 0);
  await materialized.cleanup();
});

test("buildAttachmentsReminderText lists saved uploads with type and size", () => {
  const reminder = buildAttachmentsReminderText(
    [
      {
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        data: "",
        name: "budget.xlsx",
        kind: "file",
        savedPath: `${FILE_UPLOADS_DIR}/budget.xlsx`,
        size: 45_312,
      },
      {
        mimeType: "image/png",
        data: Buffer.from("png-bytes").toString("base64"),
        name: "shot.png",
        kind: "image",
        savedPath: `${FILE_UPLOADS_DIR}/shot.png`,
        size: 9,
      },
    ],
    "/tmp/demo-workspace"
  );
  assert.ok(reminder);
  assert.ok(reminder.startsWith("<system-reminder>"));
  assert.ok(reminder.endsWith("</system-reminder>"));
  assert.ok(reminder.includes("2 files"));
  assert.ok(reminder.includes(`/tmp/demo-workspace/${FILE_UPLOADS_DIR}/budget.xlsx`));
  assert.ok(reminder.includes("Excel spreadsheet"));
  assert.ok(reminder.includes("44.3 KB"));
  assert.ok(reminder.includes("also provided inline as an image"));
});

test("buildAttachmentsReminderText returns null when nothing was saved", () => {
  assert.equal(buildAttachmentsReminderText(undefined, "/tmp/ws"), null);
  assert.equal(buildAttachmentsReminderText([], "/tmp/ws"), null);
  assert.equal(
    buildAttachmentsReminderText(
      [{ mimeType: "image/png", data: "abc", name: "inline-only.png" }],
      "/tmp/ws"
    ),
    null
  );
});

test("buildAttachmentsReminderText rejects saved paths outside the uploads directory", () => {
  assert.equal(
    buildAttachmentsReminderText(
      [
        {
          mimeType: "text/plain",
          data: "",
          name: "evil.txt",
          kind: "file",
          savedPath: "../../etc/passwd",
        },
        {
          mimeType: "text/plain",
          data: "",
          name: "sneaky.txt",
          kind: "file",
          savedPath: `${FILE_UPLOADS_DIR}/../../.ssh/id_rsa`,
        },
      ],
      "/tmp/ws"
    ),
    null
  );
});

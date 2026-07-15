import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type PromptAttachment = {
  mimeType: string;
  data: string;
  name?: string;
};

function imageExtension(attachment: PromptAttachment): string {
  const fromName = attachment.name?.match(/\.([a-z0-9]{2,8})$/i)?.[1];
  if (fromName) {
    return fromName.toLowerCase();
  }
  const subtype = attachment.mimeType.split("/")[1]?.split(";")[0]?.trim().toLowerCase();
  if (subtype === "jpeg") return "jpg";
  return subtype || "png";
}

function decodeAttachmentData(data: string): Buffer {
  const match = /^data:[^;,]+(?:;[^,]+)*;base64,(.+)$/i.exec(data.trim());
  return Buffer.from(match?.[1] ?? data, "base64");
}

export async function materializeImageAttachments(
  attachments: PromptAttachment[] | undefined,
  prefix: string
): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
  const images = (attachments ?? []).filter((attachment) =>
    attachment.mimeType.startsWith("image/")
  );
  if (images.length === 0) {
    return { paths: [], cleanup: async () => undefined };
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-images-`));
  const paths: string[] = [];
  await Promise.all(images.map(async (attachment, index) => {
    const filePath = path.join(
      dir,
      `${index}-${randomUUID()}.${imageExtension(attachment)}`
    );
    await fs.writeFile(filePath, decodeAttachmentData(attachment.data));
    paths.push(filePath);
  }));
  return {
    paths,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function resolveOpenCodeExportCommand(): string {
  const configured = process.env.OPENCURSOR_OPENCODE_ACP_BIN?.trim();
  return configured || "opencode";
}

export async function exportOpenCodeSession(sessionId: string): Promise<unknown> {
  const command = resolveOpenCodeExportCommand();
  const { stdout } = await execFileAsync("script", [
    "-qec",
    `${command} export ${sessionId}`,
    "/dev/null",
  ], {
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
  });
  const normalized = stdout.replace(/\r/g, "");
  const jsonStart = normalized.indexOf("{");
  const jsonEnd = normalized.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < jsonStart) {
    throw new Error("OpenCode export did not return JSON.");
  }
  return JSON.parse(normalized.slice(jsonStart, jsonEnd + 1));
}

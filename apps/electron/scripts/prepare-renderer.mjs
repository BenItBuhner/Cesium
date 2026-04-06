import fs from "node:fs/promises";
import path from "node:path";

const appRoot = new URL("../", import.meta.url);
const rendererSource = new URL("../../web/out/", import.meta.url);
const rendererTarget = new URL("../dist/renderer/", import.meta.url);

async function main() {
  await fs.rm(rendererTarget, { recursive: true, force: true });
  await fs.mkdir(rendererTarget, { recursive: true });
  await fs.cp(rendererSource, rendererTarget, { recursive: true });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

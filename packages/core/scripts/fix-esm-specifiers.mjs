import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(packageRoot, "dist");
const relativeFromPattern = /(\bfrom\s+["'])(\.\.?\/[^"']+)(["'])/g;
const relativeImportTypePattern = /(\bimport\(["'])(\.\.?\/[^"']+)(["']\))/g;

function appendJsExtension(match, prefix, specifier, suffix) {
  if (path.extname(specifier)) return match;
  return `${prefix}${specifier}.js${suffix}`;
}

async function rewriteDirectory(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await rewriteDirectory(target);
        return;
      }
      if (!entry.isFile() || (!entry.name.endsWith(".js") && !entry.name.endsWith(".d.ts"))) {
        return;
      }
      const source = await fs.readFile(target, "utf8");
      const rewritten = source
        .replace(relativeFromPattern, appendJsExtension)
        .replace(relativeImportTypePattern, appendJsExtension);
      if (rewritten !== source) {
        await fs.writeFile(target, rewritten);
      }
    })
  );
}

await rewriteDirectory(distRoot);

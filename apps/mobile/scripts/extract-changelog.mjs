import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2]?.trim();
if (!version) {
  console.error("Usage: node scripts/extract-changelog.mjs <version>");
  process.exit(1);
}

const changelogPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../CHANGELOG.md");
const changelog = readFileSync(changelogPath, "utf8");
const header = `## [${version}]`;
const start = changelog.indexOf(header);

if (start === -1) {
  console.error(`No changelog section found for version ${version} in ${changelogPath}`);
  process.exit(1);
}

const afterHeader = changelog.indexOf("\n", start);
const nextSection = changelog.indexOf("\n## ", afterHeader + 1);
const section = changelog
  .slice(afterHeader + 1, nextSection === -1 ? undefined : nextSection)
  .trim();

if (!section) {
  console.error(`Changelog section for version ${version} is empty`);
  process.exit(1);
}

process.stdout.write(`${section}\n`);

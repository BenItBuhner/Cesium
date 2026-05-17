const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");

const recursiveRootLinks = ["server/node_modules/cesium"];
const forbiddenPaths = ["apps/desktop/out/win-unpacked/resources/server/node_modules/cesium"];

const forbiddenSegments = [
  `${path.sep}g${path.sep}caches${path.sep}`,
  `${path.sep}.gradle${path.sep}`,
];

function exists(relativePath) {
  return fs.existsSync(path.join(repoRoot, relativePath));
}

function removeSafeRecursiveRootLink(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    return null;
  }
  let realPath;
  try {
    realPath = fs.realpathSync(absolutePath);
  } catch {
    return `${relativePath} (cannot resolve real path)`;
  }
  if (path.resolve(realPath).toLowerCase() !== repoRoot.toLowerCase()) {
    return `${relativePath} (points to ${realPath})`;
  }
  try {
    fs.rmdirSync(absolutePath);
    console.log(`Removed recursive workspace root link: ${relativePath}`);
    return null;
  } catch (error) {
    return `${relativePath} (failed to remove root link: ${
      error instanceof Error ? error.message : String(error)
    })`;
  }
}

function scanForForbiddenSegments(rootRelativePath) {
  const root = path.join(repoRoot, rootRelativePath);
  const hits = [];
  if (!fs.existsSync(root)) {
    return hits;
  }

  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const normalized = current + path.sep;
    if (forbiddenSegments.some((segment) => normalized.includes(segment))) {
      hits.push(path.relative(repoRoot, current));
      continue;
    }
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      stack.push(path.join(current, entry.name));
    }
  }
  return hits;
}

const failures = [];

for (const relativePath of recursiveRootLinks) {
  const failure = removeSafeRecursiveRootLink(relativePath);
  if (failure) {
    failures.push(failure);
  }
}

for (const relativePath of forbiddenPaths) {
  if (exists(relativePath)) {
    failures.push(relativePath);
  }
}

for (const hit of scanForForbiddenSegments("server/node_modules")) {
  failures.push(hit);
}

for (const hit of scanForForbiddenSegments("apps/desktop/out")) {
  failures.push(hit);
}

if (failures.length > 0) {
  console.error("Refusing to package Cesium desktop because forbidden cache/recursive paths exist:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  console.error("Remove these generated directories before running Electron packaging.");
  process.exit(1);
}

console.log("Desktop package safety check passed.");

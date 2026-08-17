import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// iOS counterpart of run-gradle.mjs: builds the CocoaPods-generated workspace
// with sane defaults for an unsigned local/CI build. Usage:
//   node scripts/run-xcodebuild.mjs [--configuration Release|Debug]
//     [--destination <xcodebuild destination>] [extra xcodebuild args...]

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const iosRoot = path.join(mobileRoot, "ios");

if (process.platform !== "darwin") {
  console.error("iOS builds require macOS (xcodebuild). Run this on a Mac or in CI.");
  process.exit(1);
}

const args = process.argv.slice(2);
const passthrough = [];
let configuration = "Release";
let destination = "generic/platform=iOS Simulator";

for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--configuration" && args[index + 1]) {
    configuration = args[(index += 1)];
  } else if (args[index] === "--destination" && args[index + 1]) {
    destination = args[(index += 1)];
  } else {
    passthrough.push(args[index]);
  }
}

const workspace = path.join(iosRoot, "CesiumMobile.xcworkspace");
if (!existsSync(workspace)) {
  console.error(
    `Missing ${workspace}. Run "pod install --project-directory=ios" (npm run pods:ios) first.`
  );
  process.exit(1);
}

const result = spawnSync(
  "xcodebuild",
  [
    "-workspace",
    "CesiumMobile.xcworkspace",
    "-scheme",
    "CesiumMobile",
    "-configuration",
    configuration,
    "-destination",
    destination,
    "-derivedDataPath",
    "build",
    // Simulator/CI builds never need signing; device builds go through Xcode.
    "CODE_SIGNING_ALLOWED=NO",
    "CODE_SIGNING_REQUIRED=NO",
    "build",
    ...passthrough,
  ],
  {
    cwd: iosRoot,
    stdio: "inherit",
  }
);

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);

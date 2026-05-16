const fs = require("node:fs");
const path = require("node:path");

const settingsPath = path.join(
  __dirname,
  "..",
  "node_modules",
  "@react-native",
  "gradle-plugin",
  "settings.gradle.kts"
);

if (!fs.existsSync(settingsPath)) {
  process.exit(0);
}

const source = fs.readFileSync(settingsPath, "utf8");
const oldPin =
  'id("org.gradle.toolchains.foojay-resolver-convention").version("0.5.0")';
const newPin =
  'id("org.gradle.toolchains.foojay-resolver-convention").version("1.0.0")';

if (!source.includes(oldPin)) {
  process.exit(0);
}

fs.writeFileSync(settingsPath, source.replace(oldPin, newPin));
console.log(
  "Patched @react-native/gradle-plugin foojay resolver to 1.0.0 for Gradle 9."
);

import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const commands = [
  ["run", "build:web-assets"],
  ["run", "bundle:android"],
];

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(npm, args, {
      cwd: new URL("..", import.meta.url),
      stdio: "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${npm} ${args.join(" ")} failed with ${signal ? `signal ${signal}` : `exit ${code}`}`
        )
      );
    });
  });
}

await Promise.all(commands.map(run));

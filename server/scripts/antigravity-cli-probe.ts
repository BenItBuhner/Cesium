import { spawn } from "node:child_process";

type ProbeScenario = {
  id: string;
  prompt: string;
  requiresAuth?: boolean;
};

const scenarios: ProbeScenario[] = [
  { id: "read", prompt: "Read package.json and summarize the project name." },
  { id: "grep", prompt: "Search for AgentBackendId and report the matching files." },
  { id: "web_fetch", prompt: "Search the web for Google Antigravity CLI docs and summarize the install note.", requiresAuth: true },
  { id: "edit", prompt: "Create a harmless temporary file under .agents/probe.txt, then remove it.", requiresAuth: true },
  { id: "terminal", prompt: "Run a simple command that prints the current working directory.", requiresAuth: true },
  { id: "permission_prompt", prompt: "Ask for permission before running a terminal command.", requiresAuth: true },
  { id: "subagent_task", prompt: "Invoke a subagent to inspect the README and summarize it.", requiresAuth: true },
  { id: "manage_task", prompt: "Use manage_task to create a short three-step plan.", requiresAuth: true },
  { id: "cancel", prompt: "Start a long-running reasoning task so the harness can be cancelled externally.", requiresAuth: true },
  { id: "resume", prompt: "Print the current conversation resume command if available.", requiresAuth: true },
  { id: "auth_failure", prompt: "Start without ambient auth and confirm an auth-required warning." },
];

function runAgy(args: string[], input?: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.env.OPENCURSOR_ANTIGRAVITY_CLI_BIN || process.env.OPENCURSOR_AGY_BIN || "agy", args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", (error) => {
      resolve({ code: null, output: error.message });
    });
    child.on("exit", (code) => {
      resolve({ code, output });
    });
    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

async function main(): Promise<void> {
  const availability = await runAgy(["--help"]);
  if (availability.code !== 0) {
    console.log("Antigravity CLI probe skipped: agy is not available.");
    console.log(availability.output.trim());
    return;
  }

  console.log("Antigravity CLI probe checklist:");
  for (const scenario of scenarios) {
    console.log(`- ${scenario.id}: ${scenario.prompt}`);
  }
  console.log("");
  console.log("Run individual prompts through OpenCursor for full event verification.");
  console.log("This script only verifies that the agy binary is reachable and prints the live scenario checklist.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

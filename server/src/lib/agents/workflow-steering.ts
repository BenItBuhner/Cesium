import type { WorkflowRunRecord } from "./workflow-types.js";
import { formatWorkflowRunForModel } from "./workflow-types.js";

export function workflowModeContinuationContext(run: WorkflowRunRecord | null): string {
  if (!run) {
    return `<workflow_context>
You are in Workflow mode. Write a JavaScript orchestration script and execute it with workflow_run.
Scripts MUST begin with:
export const meta = { name, description, phases: [{ title, detail }] }
Then use agent()/parallel()/pipeline()/phase()/log()/budget/args.
Prefer pipeline() for multi-stage item work. Use parallel() only when a later stage needs every prior result at once.
Keep intermediate results in script variables — do not paste every subagent transcript into the parent reply.
</workflow_context>`;
  }
  return `<workflow_context>
Continue the active Workflow mode run.
${formatWorkflowRunForModel(run)}
- Use workflow_status to inspect progress.
- Use workflow_await if the run is still running.
- Use workflow_control to pause, resume, stop, or restart the run when needed.
- To iterate, edit the script file and call workflow_run with scriptPath + resumeFromRunId.
- Only summarize the final return value to the user; keep intermediate agent output out of the parent reply.
</workflow_context>`;
}

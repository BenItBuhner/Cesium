import {
  appendGoalSnapshot,
  blockGoal,
  completeGoal,
  ensureGoalForConversation,
  formatGoalForModel,
  pauseGoal,
  readGoalForConversation,
  resumeGoal,
  updateGoal,
  updateGoalPlan,
  updateGoalProgress,
} from "../../goal-store.js";
import { asNumber } from "../../json-coerce.js";
import { asString } from "../cesium-coerce.js";
import { GOAL_VERIFIER_MAX_REJECTIONS, verifyGoalCompletion } from "../../goal-continuation.js";
import type { CesiumToolContext } from "./types.js";
import { readWorkLedger } from "../../work-ledger.js";
import { appendTodoPlanEvent, ledgerScope } from "./plan-tools.js";

/** Goal todos are ledger tasks, so a Goal tool that changes them refreshes the chat's todo list. */
async function showGoalItems(ctx: CesiumToolContext, args: Record<string, unknown>): Promise<void> {
  if (Array.isArray(args.todos) || Array.isArray(args.milestones)) {
    await appendTodoPlanEvent(ctx, await readWorkLedger(ledgerScope(ctx)), args);
  }
}

export async function goalGetTool(ctx: CesiumToolContext): Promise<string> {
  const goal = await readGoalForConversation({
    workspace: ctx.workspace,
    conversationId: ctx.conversationId,
  });
  return goal ? formatGoalForModel(goal) : "No Goal exists for this conversation.";
}

export async function goalSetTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>): Promise<string> {
  const objective = asString(args.objective);
  let goal = await readGoalForConversation({
    workspace: ctx.workspace,
    conversationId: ctx.conversationId,
  });
  if (!goal) {
    if (!objective) {
      throw new Error("goal_set.objective is required when no Goal exists.");
    }
    goal = await ensureGoalForConversation({
      workspace: ctx.workspace,
      conversationId: ctx.conversationId,
      objective,
    });
  } else if (objective && objective !== goal.objective) {
    goal = await updateGoal({
      workspace: ctx.workspace,
      conversationId: ctx.conversationId,
      patch: {
        objective,
        status: goal.status === "planning" || goal.status === "paused" ? "active" : goal.status,
        phase: goal.phase === "planning" ? "executing" : goal.phase,
      },
    });
  }

  const hasPlanState =
    asString(args.planSummary) != null ||
    Array.isArray(args.milestones) ||
    Array.isArray(args.todos);
  if (hasPlanState) {
    goal = await updateGoalPlan({
      workspace: ctx.workspace,
      conversationId: ctx.conversationId,
      planSummary: asString(args.planSummary),
      milestones: Array.isArray(args.milestones) ? args.milestones : undefined,
      todos: Array.isArray(args.todos) ? args.todos : undefined,
    });
  }

  if (Array.isArray(args.verificationEvidence)) {
    goal = await updateGoalProgress({
      workspace: ctx.workspace,
      conversationId: ctx.conversationId,
      verificationEvidence: args.verificationEvidence,
    });
  }

  const tokenBudget = asNumber(args.tokenBudget);
  if (tokenBudget != null) {
    if (!Number.isInteger(tokenBudget) || tokenBudget < 0) {
      throw new Error("goal_set.tokenBudget must be a non-negative integer.");
    }
    goal = await updateGoal({
      workspace: ctx.workspace,
      conversationId: ctx.conversationId,
      patch: {
        tokenBudget: tokenBudget === 0 ? null : tokenBudget,
        ...(goal.status === "budget_limited" && (tokenBudget === 0 || tokenBudget > goal.tokensUsed)
          ? { status: "active" as const }
          : {}),
      },
    });
  }

  const progressPercent = asNumber(args.progressPercent);
  const headline = asString(args.headline);
  if (progressPercent != null || headline) {
    const patch: Parameters<typeof updateGoal>[0]["patch"] = {};
    if (progressPercent != null) {
      const rounded = Math.round(progressPercent);
      if (
        !Number.isFinite(progressPercent) ||
        rounded !== progressPercent ||
        rounded < 0 ||
        rounded > 100
      ) {
        throw new Error("goal_set.progressPercent must be an integer from 0 to 100.");
      }
      patch.progressPercent = rounded;
    }
    if (headline) {
      patch.headline = headline;
    }
    goal = await updateGoal({
      workspace: ctx.workspace,
      conversationId: ctx.conversationId,
      patch,
    });
  }

  if (goal.status === "planning") {
    goal = await updateGoal({
      workspace: ctx.workspace,
      conversationId: ctx.conversationId,
      patch: {
        status: "active",
        phase: goal.phase === "planning" ? "executing" : goal.phase,
      },
    });
  }

  await showGoalItems(ctx, args);
  return `Goal set.\n\n${formatGoalForModel(goal)}`;
}

export async function goalUpdatePlanTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>): Promise<string> {
  const planSummary = asString(args.planSummary);
  if (!planSummary) {
    throw new Error("goal_update_plan.planSummary is required.");
  }
  const goal = await updateGoalPlan({
    workspace: ctx.workspace,
    conversationId: ctx.conversationId,
    planSummary,
    milestones: Array.isArray(args.milestones) ? args.milestones : [],
    todos: Array.isArray(args.todos) ? args.todos : [],
  });
  await showGoalItems(ctx, args);
  return `Goal plan recorded.\n\n${formatGoalForModel(goal)}`;
}

export async function goalUpdateProgressTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>): Promise<string> {
  const goal = await updateGoalProgress({
    workspace: ctx.workspace,
    conversationId: ctx.conversationId,
    milestones: Array.isArray(args.milestones) ? args.milestones : undefined,
    todos: Array.isArray(args.todos) ? args.todos : undefined,
    verificationEvidence: Array.isArray(args.verificationEvidence)
      ? args.verificationEvidence
      : undefined,
  });
  await showGoalItems(ctx, args);
  return `Goal progress updated.\n\n${formatGoalForModel(goal)}`;
}

export async function goalSummarizeTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>): Promise<string> {
  const progressPercent = asNumber(args.progressPercent);
  const summary = asString(args.summary);
  if (progressPercent == null) {
    throw new Error("goal_summarize.progressPercent is required.");
  }
  if (!summary) {
    throw new Error("goal_summarize.summary is required.");
  }
  const goal = await appendGoalSnapshot({
    workspace: ctx.workspace,
    conversationId: ctx.conversationId,
    progressPercent,
    summary,
    headline: asString(args.headline),
  });
  return `Goal summarized.\n\n${formatGoalForModel(goal)}`;
}

/** Verifier rejections per Goal since its last completion attempt passed. */
const verifierRejections = new Map<string, number>();

export async function goalCompleteTool(ctx: CesiumToolContext): Promise<string> {
  const current = await readGoalForConversation({
    workspace: ctx.workspace,
    conversationId: ctx.conversationId,
  });
  const findings = current ? verifyGoalCompletion(current, await ctx.readEvents()) : [];
  const rejections = current ? (verifierRejections.get(current.goalId) ?? 0) : 0;
  if (current && findings.length > 0 && rejections < GOAL_VERIFIER_MAX_REJECTIONS) {
    verifierRejections.set(current.goalId, rejections + 1);
    throw new Error(
      [
        `The Goal is not verified yet (check ${rejections + 1} of ${GOAL_VERIFIER_MAX_REJECTIONS}):`,
        ...findings.map((finding) => `- ${finding}`),
        "Fix these, then call goal_complete again.",
      ].join("\n")
    );
  }
  const goal = await completeGoal({
    workspace: ctx.workspace,
    conversationId: ctx.conversationId,
  });
  verifierRejections.delete(goal.goalId);
  return findings.length > 0
    ? [
        `Goal complete, with checks still unmet after ${GOAL_VERIFIER_MAX_REJECTIONS} attempts:`,
        ...findings.map((finding) => `- ${finding}`),
        "",
        formatGoalForModel(goal),
      ].join("\n")
    : `Goal complete.\n\n${formatGoalForModel(goal)}`;
}

export async function goalBlockTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>): Promise<string> {
  const reason = asString(args.reason);
  if (!reason) {
    throw new Error("goal_block.reason is required.");
  }
  const goal = await blockGoal({
    workspace: ctx.workspace,
    conversationId: ctx.conversationId,
    reason,
    evidence: asString(args.evidence),
  });
  return goal.status === "blocked"
    ? `Goal blocked.\n\n${formatGoalForModel(goal)}`
    : `Blocker recorded but Goal remains active until the same blocker repeats across at least three Goal turns.\n\n${formatGoalForModel(goal)}`;
}

export async function goalPauseTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>): Promise<string> {
  const goal = await pauseGoal({
    workspace: ctx.workspace,
    conversationId: ctx.conversationId,
    reason: asString(args.reason),
  });
  return `Goal paused.\n\n${formatGoalForModel(goal)}`;
}

export async function goalResumeTool(ctx: CesiumToolContext): Promise<string> {
  const goal = await resumeGoal({
    workspace: ctx.workspace,
    conversationId: ctx.conversationId,
  });
  return `Goal resumed.\n\n${formatGoalForModel(goal)}`;
}

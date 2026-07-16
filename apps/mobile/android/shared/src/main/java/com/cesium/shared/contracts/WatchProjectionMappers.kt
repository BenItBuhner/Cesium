package com.cesium.shared.contracts

fun statusChip(status: String): String =
  when (status) {
    "awaiting_permission", "awaiting_question" -> "INPUT"
    "completed", "idle" -> "DONE"
    "failed" -> "ERR"
    "cancelled", "interrupted" -> "STOP"
    "paused" -> "PAUSE"
    else -> "RUN"
  }

fun isActiveStatus(status: String): Boolean =
  status == "running" ||
    status == "pause_requested" ||
    status == "pausing" ||
    status == "awaiting_permission" ||
    status == "awaiting_question"

fun availableWatchActions(
  status: String,
  pendingIntervention: WatchPendingIntervention?,
  includePromptAction: Boolean = false
): List<String> {
  val actions = mutableListOf("open")
  when (pendingIntervention) {
    WatchPendingIntervention.QUESTION -> actions.add("answer_question")
    WatchPendingIntervention.PERMISSION -> actions.add("answer_permission")
    null -> Unit
  }
  if (isActiveStatus(status)) {
    actions.add("pause")
    actions.add("cancel")
  } else if (status == "paused") {
    actions.add("resume")
    actions.add("cancel")
  }
  actions.add("open_on_phone")
  if (includePromptAction) {
    actions.add("prompt")
  }
  return actions
}

fun staleWindowMillis(status: String): Long =
  if (isActiveStatus(status)) 45_000L else 5 * 60_000L

fun WatchAgentProjection.withSource(source: WatchConnectionSource): WatchAgentProjection =
  copy(source = source)

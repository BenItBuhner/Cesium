package com.cesium.wear.model

fun statusChip(status: String): String =
  com.cesium.shared.contracts.statusChip(status)

fun isActiveStatus(status: String): Boolean =
  com.cesium.shared.contracts.isActiveStatus(status)

fun availableWatchActions(
  status: String,
  pendingIntervention: WatchPendingIntervention?,
  includePromptAction: Boolean = false
): List<String> {
  return com.cesium.shared.contracts.availableWatchActions(
    status,
    pendingIntervention,
    includePromptAction
  )
}

fun staleWindowMillis(status: String): Long =
  com.cesium.shared.contracts.staleWindowMillis(status)

fun WatchAgentProjection.withSource(source: WatchConnectionSource): WatchAgentProjection =
  copy(source = source)

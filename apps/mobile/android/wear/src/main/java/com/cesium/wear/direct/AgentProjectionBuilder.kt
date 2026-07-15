package com.cesium.wear.direct

import com.cesium.wear.model.WatchAgentProjection
import com.cesium.wear.model.WatchConnectionSource
import com.cesium.wear.model.WatchPendingIntervention
import com.cesium.wear.model.availableWatchActions
import com.cesium.wear.model.staleWindowMillis
import com.cesium.wear.model.statusChip
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

class AgentProjectionBuilder {
  private var conversation: JsonObject? = null
  private val eventsBySeq = linkedMapOf<Long, JsonObject>()
  private var previousStartedAt: Long? = null

  fun applySocketMessage(message: JsonObject): WatchAgentProjection? {
    when (message.string("type")) {
      "conversation", "conversation_upserted" -> {
        conversation = message.obj("conversation") ?: conversation
      }
      "snapshot", "snapshot_head" -> {
        val snapshot = message.obj("snapshot")
        conversation = snapshot?.obj("conversation") ?: conversation
        snapshot?.array("events")?.forEach(::storeEvent)
      }
      "event" -> {
        storeEvent(message["event"])
      }
      "event_batch" -> {
        message.array("events")?.forEach(::storeEvent)
      }
      "conversation_deleted" -> {
        conversation = null
        eventsBySeq.clear()
        previousStartedAt = null
      }
    }
    return build()
  }

  fun build(source: WatchConnectionSource = WatchConnectionSource.DIRECT_SERVER): WatchAgentProjection? {
    val record = conversation ?: return null
    val now = System.currentTimeMillis()
    val status = resolveStatus(record)
    val active = isActiveStatus(status)
    val startedAt = if (active) {
      previousStartedAt ?: findRunStartedAt() ?: record.long("updatedAt") ?: now
    } else {
      null
    }
    previousStartedAt = startedAt
    val pendingIntervention = when {
      record.obj("pendingPermission") != null -> WatchPendingIntervention.PERMISSION
      record.obj("pendingQuestion") != null -> WatchPendingIntervention.QUESTION
      else -> null
    }
    val activity = resolveActivity(record, status, pendingIntervention)
    return WatchAgentProjection(
      workspaceId = record.string("workspaceId") ?: "",
      conversationId = record.string("id") ?: "",
      title = record.string("title") ?: "Agent",
      status = status,
      chip = statusChip(status),
      currentActivity = activity,
      currentTodo = findCurrentTodo(),
      pendingIntervention = pendingIntervention,
      elapsedMs = startedAt?.let { (now - it).coerceAtLeast(0) } ?: 0,
      lastEventSeq = maxOf(record.long("lastEventSeq") ?: 0, eventsBySeq.keys.maxOrNull() ?: 0),
      lastError = record.string("lastError"),
      source = source,
      staleAt = now + staleWindowMillis(status),
      availableActions = availableWatchActions(status, pendingIntervention)
    )
  }

  private fun storeEvent(event: JsonElement?) {
    val obj = event as? JsonObject ?: return
    val seq = obj.long("seq") ?: return
    eventsBySeq[seq] = obj
  }

  private fun resolveStatus(record: JsonObject): String {
    val status = record.string("status") ?: "idle"
    if (status == "idle" && eventsBySeq.values.any { it.string("kind") == "status" && it.string("status") == "idle" }) {
      return "completed"
    }
    return status
  }

  private fun isActiveStatus(status: String) =
    status == "running" ||
      status == "pause_requested" ||
      status == "pausing" ||
      status == "awaiting_permission" ||
      status == "awaiting_question"

  private fun findRunStartedAt(): Long? =
    eventsBySeq.values.firstOrNull { it.string("kind") == "status" && it.string("status") == "running" }
      ?.long("createdAt")
      ?: eventsBySeq.values.firstOrNull { it.string("kind") == "user_message" }?.long("createdAt")

  private fun findCurrentTodo(): String? {
    eventsBySeq.values.toList().asReversed().forEach { event ->
      if (event.string("kind") != "plan") return@forEach
      val entries = event.array("entries") ?: return@forEach
      val candidate = entries.mapNotNull { it as? JsonObject }
        .firstOrNull { it.string("status") == "in_progress" }
        ?: entries.mapNotNull { it as? JsonObject }.firstOrNull { it.string("status") == "blocked" }
        ?: entries.mapNotNull { it as? JsonObject }.firstOrNull { it.string("status") == "pending" }
      if (candidate != null) return candidate.string("content")
    }
    return null
  }

  private fun resolveActivity(
    record: JsonObject,
    status: String,
    pendingIntervention: WatchPendingIntervention?
  ): String {
    if (pendingIntervention == WatchPendingIntervention.PERMISSION) {
      val permission = record.obj("pendingPermission")
      return permission?.string("title")
        ?: permission?.string("detail")
        ?: "Needs permission"
    }
    if (pendingIntervention == WatchPendingIntervention.QUESTION) {
      return "Needs an answer"
    }
    findCurrentTodo()?.let { return it }
    eventsBySeq.values.toList().asReversed().forEach { event ->
      when (event.string("kind")) {
        "subagent" -> if (event.string("status") == "running") {
          return event.string("recentActivity") ?: event.string("title") ?: "Subagent is running"
        }
        "tool_call", "tool_call_update" -> {
          val eventStatus = event.string("status")
          if (eventStatus == "in_progress" || eventStatus == "pending") {
            return event.string("detail") ?: event.string("title") ?: "Agent is using a tool"
          }
        }
        "system" -> if (event.string("level") != "error") {
          return event.string("text") ?: "Agent is working"
        }
        "status" -> event.string("detail")?.let { return it }
      }
    }
    return when (status) {
      "idle", "completed" -> "Agent is idle"
      "failed" -> record.string("lastError") ?: "Agent run failed"
      "cancelled" -> "Agent run cancelled"
      "paused" -> "Agent run paused"
      else -> "Agent is working"
    }
  }
}

private fun JsonObject.string(key: String): String? =
  (this[key] as? JsonPrimitive)?.contentOrNull

private fun JsonObject.long(key: String): Long? =
  (this[key] as? JsonPrimitive)?.longOrNull

private fun JsonObject.obj(key: String): JsonObject? =
  this[key] as? JsonObject

private fun JsonObject.array(key: String): JsonArray? =
  this[key] as? JsonArray

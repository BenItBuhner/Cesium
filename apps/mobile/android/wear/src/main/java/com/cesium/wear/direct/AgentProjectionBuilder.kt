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

  private fun findPendingQuestionPrompt(record: JsonObject): String? {
    val questionId = record.obj("pendingQuestion")?.string("questionId")
    eventsBySeq.values.toList().asReversed().forEach { event ->
      if (event.string("kind") != "question") return@forEach
      if (questionId != null && event.string("questionId") != questionId) return@forEach
      val prompt = event.string("prompt")?.trim()
      if (!prompt.isNullOrEmpty()) return prompt
      return event.array("questions")
        ?.firstNotNullOfOrNull { (it as? JsonObject)?.string("prompt")?.trim()?.takeIf(String::isNotEmpty) }
    }
    return null
  }

  private fun resolveActivity(
    record: JsonObject,
    status: String,
    pendingIntervention: WatchPendingIntervention?
  ): String {
    if (pendingIntervention == WatchPendingIntervention.PERMISSION) {
      return describePendingPermission(record.obj("pendingPermission"))
    }
    if (pendingIntervention == WatchPendingIntervention.QUESTION) {
      // Surface the actual question verbatim; "Needs an answer" is only the
      // fallback when the question event is outside the loaded window. The
      // prompt still passes the hygiene cap so a multi-paragraph question
      // renders as one bounded line.
      return sanitizeActivityText(findPendingQuestionPrompt(record)) ?: "Needs an answer"
    }
    findCurrentTodo()?.let { todo ->
      sanitizeActivityText(todo)?.let { return it }
    }
    eventsBySeq.values.toList().asReversed().forEach { event ->
      when (event.string("kind")) {
        "subagent" -> if (event.string("status") == "running") {
          return cleanVerbatimActivityText(event.string("recentActivity"))
            ?: cleanVerbatimActivityText(event.string("title"))
            ?: "Running a subagent"
        }
        "tool_call", "tool_call_update" -> {
          val eventStatus = event.string("status")
          if (eventStatus == "in_progress" || eventStatus == "pending") {
            return describeToolCallActivity(event)
          }
        }
        // Status details and system lines can be verbose plumbing (e.g.
        // "Auto-accepted Run <entire shell command> ..."); only clean
        // one-liners qualify, everything else falls through to an older,
        // cleaner source.
        "system" -> if (event.string("level") != "error") {
          cleanVerbatimActivityText(event.string("text"))?.let { return it }
        }
        "status" -> cleanVerbatimActivityText(event.string("detail"))?.let { return it }
      }
    }
    return when (status) {
      "idle", "completed" -> "Agent is idle"
      "failed" -> sanitizeActivityText(record.string("lastError")) ?: "Agent run failed"
      "cancelled" -> "Agent run cancelled"
      "paused" -> "Agent run paused"
      else -> "Agent is working"
    }
  }

  /**
   * Clean one-line description of an in-flight tool call. Tool `detail` is
   * deliberately ignored: providers fill it with raw JSON arguments or output
   * chunks, which must never surface on a watch face. Updates that omit
   * descriptive fields recover them from the originating tool_call.
   */
  private fun describeToolCallActivity(event: JsonObject): String {
    var title = event.string("title")
    var toolKind = event.string("toolKind")
    var locations = event.array("locations")
    if (
      event.string("kind") == "tool_call_update" &&
      (title == null || toolKind == null || locations == null)
    ) {
      val toolCallId = event.string("toolCallId")
      val eventSeq = event.long("seq") ?: Long.MAX_VALUE
      val origin = eventsBySeq.values
        .filter {
          it.string("kind") == "tool_call" &&
            it.string("toolCallId") == toolCallId &&
            (it.long("seq") ?: Long.MAX_VALUE) <= eventSeq
        }
        .maxByOrNull { it.long("seq") ?: 0 }
      if (origin != null) {
        title = title ?: origin.string("title")
        toolKind = toolKind ?: origin.string("toolKind")
        locations = locations ?: origin.array("locations")
      }
    }
    return cleanVerbatimActivityText(title)
      ?: toolKindActivityLabel(toolKind, locations)
      ?: sanitizeActivityText(title)
      ?: "Using a tool"
  }

  private fun describePendingPermission(permission: JsonObject?): String {
    cleanVerbatimActivityText(permission?.string("title"))?.let { return it }
    return when (permission?.string("permission")) {
      "terminal" -> "Wants to run a terminal command"
      "editFile" -> "Wants to edit a file"
      "mcpCall" -> "Wants to use a connected tool"
      "switchMode" -> "Wants to switch modes"
      else -> cleanVerbatimActivityText(permission?.string("detail")) ?: "Needs permission"
    }
  }
}

/**
 * Length budgets mirroring @cesium/core mobile-agent-projection: verbatim
 * provider text only qualifies when it fits one clean line untruncated;
 * the hard cap bounds text with no cleaner alternative (error messages).
 */
private const val ACTIVITY_VERBATIM_MAX = 72
private const val ACTIVITY_HARD_MAX = 120
private const val ACTIVITY_FILE_LABEL_MAX = 40

private val ACTIVITY_WHITESPACE = Regex("\\s+")
private val ACTIVITY_KEY_VALUE_FRAGMENT = Regex("\"[^\"]{1,80}\"\\s*:")
private val ACTIVITY_ESCAPED_PAYLOAD = Regex("\\\\n|\\\\t|\\\\\"")

internal fun sanitizeActivityText(
  value: String?,
  maxLength: Int = ACTIVITY_HARD_MAX
): String? {
  if (value.isNullOrBlank()) return null
  val collapsed = value.replace(ACTIVITY_WHITESPACE, " ").trim()
  if (collapsed.isEmpty() || looksLikeStructuredPayload(collapsed)) return null
  if (collapsed.length <= maxLength) return collapsed
  return collapsed.take(maxLength - 1).trimEnd() + "…"
}

internal fun cleanVerbatimActivityText(
  value: String?,
  maxLength: Int = ACTIVITY_VERBATIM_MAX
): String? {
  if (value.isNullOrBlank()) return null
  val collapsed = value.replace(ACTIVITY_WHITESPACE, " ").trim()
  if (
    collapsed.isEmpty() ||
    collapsed.length > maxLength ||
    looksLikeStructuredPayload(collapsed)
  ) {
    return null
  }
  return collapsed
}

private fun looksLikeStructuredPayload(text: String): Boolean {
  if (text.startsWith("{") || text.startsWith("[")) return true
  if (ACTIVITY_KEY_VALUE_FRAGMENT.containsMatchIn(text)) return true
  if (ACTIVITY_ESCAPED_PAYLOAD.containsMatchIn(text)) return true
  return false
}

internal fun toolKindActivityLabel(toolKind: String?, locations: JsonArray?): String? {
  val firstPath = (locations?.firstOrNull() as? JsonObject)?.string("path")
  val file = firstPath?.let {
    cleanVerbatimActivityText(activityPathBasename(it), ACTIVITY_FILE_LABEL_MAX)
  }
  return when (toolKind) {
    "read" -> if (file != null) "Reading $file" else "Reading files"
    "edit" -> if (file != null) "Editing $file" else "Editing files"
    "delete" -> if (file != null) "Deleting $file" else "Deleting files"
    "move" -> "Moving files"
    "terminal", "execute" -> "Running a terminal command"
    "grep", "search" -> "Searching the workspace"
    "search_web" -> "Searching the web"
    "fetch" -> "Fetching a web page"
    "browser" -> "Using the browser"
    "todo" -> "Updating the plan"
    "goal" -> "Updating goal progress"
    "mcp" -> "Using a connected tool"
    "subagent", "task" -> "Running a subagent"
    "question" -> "Preparing a question"
    "memory" -> "Updating memory"
    "workflow" -> "Running a workflow"
    "orchestration" -> "Coordinating agents"
    "mode", "switch_mode" -> "Switching modes"
    "wait" -> "Waiting"
    "think" -> "Thinking"
    else -> null
  }
}

private fun activityPathBasename(path: String): String {
  val cleaned = path.removePrefix("file://").substringBefore('?')
  val last = cleaned.split('/', '\\').last()
  return last.ifEmpty { cleaned }
}

private fun JsonObject.string(key: String): String? =
  (this[key] as? JsonPrimitive)?.contentOrNull

private fun JsonObject.long(key: String): Long? =
  (this[key] as? JsonPrimitive)?.longOrNull

private fun JsonObject.obj(key: String): JsonObject? =
  this[key] as? JsonObject

private fun JsonObject.array(key: String): JsonArray? =
  this[key] as? JsonArray

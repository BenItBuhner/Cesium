package com.cesium.wear.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

const val WATCH_SCHEMA_VERSION = 1

object WearDataPaths {
  const val CURRENT_PROJECTION = "/cesium/projection/current"
  const val CURRENT_CONFIG = "/cesium/config/current"
  const val ACTION_PREFIX = "/cesium/action"
  const val ACTION_OPEN_ON_PHONE = "$ACTION_PREFIX/open_on_phone"
  const val ACTION_CANCEL = "$ACTION_PREFIX/cancel"
  const val ACTION_PAUSE = "$ACTION_PREFIX/pause"
  const val ACTION_RESUME = "$ACTION_PREFIX/resume"
  const val ACTION_ANSWER_QUESTION = "$ACTION_PREFIX/answer_question"
  const val ACTION_ANSWER_PERMISSION = "$ACTION_PREFIX/answer_permission"
  const val ACTION_PROMPT = "$ACTION_PREFIX/prompt"
  const val PHONE_RELAY_CAPABILITY = "cesium_phone_relay"
  const val WATCH_CLIENT_CAPABILITY = "cesium_watch_client"
}

@Serializable
enum class WatchConnectionSource {
  @SerialName("direct_server")
  DIRECT_SERVER,

  @SerialName("phone_companion")
  PHONE_COMPANION,

  @SerialName("cache")
  CACHE
}

@Serializable
enum class WatchPendingIntervention {
  @SerialName("permission")
  PERMISSION,

  @SerialName("question")
  QUESTION
}

@Serializable
data class WatchAgentProjection(
  val schemaVersion: Int = WATCH_SCHEMA_VERSION,
  val workspaceId: String,
  val conversationId: String,
  val title: String,
  val status: String,
  val chip: String,
  val currentActivity: String,
  val currentTodo: String? = null,
  val pendingIntervention: WatchPendingIntervention? = null,
  val elapsedMs: Long = 0,
  val lastEventSeq: Long = 0,
  val lastError: String? = null,
  val source: WatchConnectionSource = WatchConnectionSource.CACHE,
  val staleAt: Long = 0,
  val availableActions: List<String> = emptyList()
) {
  val isStale: Boolean
    get() = staleAt > 0 && System.currentTimeMillis() > staleAt

  val isActionable: Boolean
    get() = pendingIntervention != null
}

@Serializable
data class WatchServerConfig(
  val id: String? = null,
  val label: String? = null,
  val baseUrl: String? = null,
  val authToken: String? = null
)

@Serializable
data class WatchFocusedConversation(
  val workspaceId: String? = null,
  val conversationId: String? = null,
  val lastEventSeq: Long = 0
)

@Serializable
data class WatchAgentUsageSnapshot(
  val usedTokens: Long? = null,
  val maxTokens: Long? = null,
  val percent: Double? = null,
  val label: String? = null
)

@Serializable
data class WatchAgentSyncEnvelope(
  val schemaVersion: Int = WATCH_SCHEMA_VERSION,
  val server: WatchServerConfig? = null,
  val focused: WatchFocusedConversation? = null,
  val projection: WatchAgentProjection? = null,
  val usage: WatchAgentUsageSnapshot? = null,
  val source: WatchConnectionSource = WatchConnectionSource.CACHE,
  val updatedAt: Long = System.currentTimeMillis()
)

@Serializable
data class WatchAgentActionRequest(
  val schemaVersion: Int = WATCH_SCHEMA_VERSION,
  val action: String,
  val workspaceId: String? = null,
  val conversationId: String,
  val questionId: String? = null,
  val answer: String? = null,
  val requestId: String? = null,
  val optionId: String? = null,
  val cancelled: Boolean? = null,
  val text: String? = null,
  val delivery: String? = null
)

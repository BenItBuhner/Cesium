package com.cesium.shared.contracts

import com.cesium.shared.generated.CesiumWatchSchema
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

val WATCH_SCHEMA_VERSION: Int
  get() = CesiumWatchSchema.VERSION

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
  val schemaVersion: Int = CesiumWatchSchema.VERSION,
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
  val schemaVersion: Int = CesiumWatchSchema.VERSION,
  val server: WatchServerConfig? = null,
  val focused: WatchFocusedConversation? = null,
  val projection: WatchAgentProjection? = null,
  val usage: WatchAgentUsageSnapshot? = null,
  val source: WatchConnectionSource = WatchConnectionSource.CACHE,
  val updatedAt: Long = System.currentTimeMillis()
)

@Serializable
data class WatchAgentActionRequest(
  val schemaVersion: Int = CesiumWatchSchema.VERSION,
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

package com.cesium.wear.model

import com.cesium.shared.generated.CesiumCapabilities
import com.cesium.shared.generated.CesiumDataLayerPaths
import com.cesium.shared.generated.CesiumWatchSchema

val WATCH_SCHEMA_VERSION: Int
  get() = CesiumWatchSchema.VERSION

object WearDataPaths {
  const val CURRENT_PROJECTION = CesiumDataLayerPaths.CURRENT_PROJECTION
  const val CURRENT_CONFIG = CesiumDataLayerPaths.CURRENT_CONFIG
  const val ACTION_PREFIX = CesiumDataLayerPaths.ACTION_PREFIX
  const val ACTION_OPEN_ON_PHONE = "$ACTION_PREFIX/open_on_phone"
  const val ACTION_CANCEL = "$ACTION_PREFIX/cancel"
  const val ACTION_PAUSE = "$ACTION_PREFIX/pause"
  const val ACTION_RESUME = "$ACTION_PREFIX/resume"
  const val ACTION_ANSWER_QUESTION = "$ACTION_PREFIX/answer_question"
  const val ACTION_ANSWER_PERMISSION = "$ACTION_PREFIX/answer_permission"
  const val ACTION_PROMPT = "$ACTION_PREFIX/prompt"
  const val PHONE_RELAY_CAPABILITY = CesiumCapabilities.PHONE_RELAY
  const val WATCH_CLIENT_CAPABILITY = CesiumCapabilities.WATCH_CLIENT
}

typealias WatchConnectionSource = com.cesium.shared.contracts.WatchConnectionSource
typealias WatchPendingIntervention = com.cesium.shared.contracts.WatchPendingIntervention
typealias WatchAgentProjection = com.cesium.shared.contracts.WatchAgentProjection
typealias WatchServerConfig = com.cesium.shared.contracts.WatchServerConfig
typealias WatchFocusedConversation = com.cesium.shared.contracts.WatchFocusedConversation
typealias WatchAgentUsageSnapshot = com.cesium.shared.contracts.WatchAgentUsageSnapshot
typealias WatchAgentSyncEnvelope = com.cesium.shared.contracts.WatchAgentSyncEnvelope
typealias WatchAgentActionRequest = com.cesium.shared.contracts.WatchAgentActionRequest

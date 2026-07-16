package com.cesium.mobile.wear

import com.cesium.shared.wear.CesiumWearTransport
import com.cesium.shared.wear.WearRelayConfigPayload
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap

class CesiumWearCompanionModule(
  private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "CesiumWearCompanion"

  @ReactMethod
  fun publishEnvelope(envelopeJson: String, config: ReadableMap, promise: Promise) {
    try {
      val relayConfig = RelayConfig(
        serverBaseUrl = config.getStringOrNull("serverBaseUrl") ?: "",
        serverLabel = config.getStringOrNull("serverLabel") ?: "This device",
        authToken = config.getStringOrNull("authToken"),
        workspaceId = config.getStringOrNull("workspaceId") ?: "",
        conversationId = config.getStringOrNull("conversationId")
      )
      CesiumWearRelayState.save(reactContext, relayConfig)
      CesiumWearTransport(reactContext).publishEnvelope(
        envelopeJson,
        WearRelayConfigPayload(
          serverLabel = relayConfig.serverLabel,
          serverBaseUrl = relayConfig.serverBaseUrl,
          workspaceId = relayConfig.workspaceId,
          conversationId = relayConfig.conversationId
        )
      )
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("CESIUM_WEAR_PUBLISH_FAILED", "Failed to publish Wear OS state", error)
    }
  }

}

private fun ReadableMap.getStringOrNull(key: String): String? =
  if (hasKey(key) && !isNull(key)) getString(key)?.takeIf { it.isNotBlank() } else null

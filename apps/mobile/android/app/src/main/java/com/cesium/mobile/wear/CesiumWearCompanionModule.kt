package com.cesium.mobile.wear

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable

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
      publishDataItem(CesiumWearPaths.CURRENT_PROJECTION, envelopeJson)
      publishDataItem(
        CesiumWearPaths.CURRENT_CONFIG,
        """
        {
          "serverLabel":${jsonString(relayConfig.serverLabel)},
          "serverBaseUrl":${jsonString(relayConfig.serverBaseUrl)},
          "workspaceId":${jsonString(relayConfig.workspaceId)},
          "conversationId":${jsonString(relayConfig.conversationId)}
        }
        """.trimIndent()
      )
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("CESIUM_WEAR_PUBLISH_FAILED", "Failed to publish Wear OS state", error)
    }
  }

  private fun publishDataItem(path: String, json: String) {
    val request = PutDataMapRequest.create(path).apply {
      dataMap.putString("json", json)
      dataMap.putLong("updatedAt", System.currentTimeMillis())
    }.asPutDataRequest().setUrgent()
    Wearable.getDataClient(reactContext).putDataItem(request)
  }

  private fun jsonString(value: String?): String =
    value?.let { "\"${it.replace("\\", "\\\\").replace("\"", "\\\"")}\"" } ?: "null"
}

private fun ReadableMap.getStringOrNull(key: String): String? =
  if (hasKey(key) && !isNull(key)) getString(key)?.takeIf { it.isNotBlank() } else null

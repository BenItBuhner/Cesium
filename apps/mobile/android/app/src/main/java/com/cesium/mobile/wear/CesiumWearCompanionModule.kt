package com.cesium.mobile.wear

import com.cesium.shared.wear.CesiumWearTransport
import com.cesium.shared.wear.PhoneRelayStatus
import com.cesium.shared.wear.WearRelayConfigPayload
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

class CesiumWearCompanionModule(
  private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val pendingConnectionPromises = ConcurrentHashMap.newKeySet<Promise>()

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

  @ReactMethod
  fun getConnectionStatus(promise: Promise) {
    pendingConnectionPromises.add(promise)
    scope.launch {
      try {
        val status = CesiumWearTransport(reactContext).phoneRelayStatus()
        val map = Arguments.createMap().apply {
          putString("status", status.name.lowercase())
          putBoolean(
            "reachable",
            status == PhoneRelayStatus.NEARBY || status == PhoneRelayStatus.CLOUD
          )
          putBoolean("nearby", status == PhoneRelayStatus.NEARBY)
        }
        if (pendingConnectionPromises.remove(promise)) {
          promise.resolve(map)
        }
      } catch (error: CancellationException) {
        if (pendingConnectionPromises.remove(promise)) {
          promise.reject(
            "CESIUM_WEAR_MODULE_INVALIDATED",
            "Wear companion module was invalidated",
            error
          )
        }
      } catch (error: Throwable) {
        if (pendingConnectionPromises.remove(promise)) {
          promise.reject(
            "CESIUM_WEAR_STATUS_FAILED",
            "Failed to read Wear OS connection status",
            error
          )
        }
      }
    }
  }

  override fun invalidate() {
    pendingConnectionPromises.forEach { promise ->
      promise.reject(
        "CESIUM_WEAR_MODULE_INVALIDATED",
        "Wear companion module was invalidated"
      )
    }
    pendingConnectionPromises.clear()
    scope.cancel()
    super.invalidate()
  }

}

private fun ReadableMap.getStringOrNull(key: String): String? =
  if (hasKey(key) && !isNull(key)) getString(key)?.takeIf { it.isNotBlank() } else null

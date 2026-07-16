package com.cesium.shared.wear

import android.content.Context
import com.cesium.shared.generated.CesiumCapabilities
import com.cesium.shared.generated.CesiumDataLayerPaths
import com.google.android.gms.wearable.CapabilityClient
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.tasks.await
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

@Serializable
data class WearRelayConfigPayload(
  val serverLabel: String,
  val serverBaseUrl: String,
  val workspaceId: String,
  val conversationId: String? = null
)

enum class PhoneRelayStatus {
  NOT_PAIRED,
  OFFLINE,
  CLOUD,
  NEARBY
}

class CesiumWearTransport(
  private val context: Context,
  private val json: Json = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
  }
) {
  fun publishEnvelope(envelopeJson: String, config: WearRelayConfigPayload) {
    publishDataItem(CesiumDataLayerPaths.CURRENT_PROJECTION, envelopeJson)
    publishDataItem(
      CesiumDataLayerPaths.CURRENT_CONFIG,
      json.encodeToString(config)
    )
  }

  suspend fun phoneRelayStatus(): PhoneRelayStatus {
    val all = Wearable.getCapabilityClient(context)
      .getCapability(CesiumCapabilities.PHONE_RELAY, CapabilityClient.FILTER_ALL)
      .await()
      .nodes
    if (all.isEmpty()) return PhoneRelayStatus.NOT_PAIRED
    val reachable = Wearable.getCapabilityClient(context)
      .getCapability(CesiumCapabilities.PHONE_RELAY, CapabilityClient.FILTER_REACHABLE)
      .await()
      .nodes
    if (reachable.isEmpty()) return PhoneRelayStatus.OFFLINE
    return if (reachable.any { it.isNearby }) PhoneRelayStatus.NEARBY else PhoneRelayStatus.CLOUD
  }

  private fun publishDataItem(path: String, payload: String) {
    val request = PutDataMapRequest.create(path).apply {
      dataMap.putString("json", payload)
      dataMap.putLong("updatedAt", System.currentTimeMillis())
    }.asPutDataRequest().setUrgent()
    Wearable.getDataClient(context).putDataItem(request)
  }
}

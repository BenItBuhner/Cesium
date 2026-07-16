package com.cesium.wear.sync

import android.content.Context
import com.cesium.shared.generated.CesiumCapabilities
import com.cesium.shared.generated.CesiumDataLayerPaths
import com.cesium.wear.model.WatchAgentActionRequest
import com.google.android.gms.wearable.CapabilityClient
import com.google.android.gms.wearable.MessageClient
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.tasks.await
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

class PhoneCompanionActionClient(
  context: Context,
  private val json: Json = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
  },
  private val messageClient: MessageClient = Wearable.getMessageClient(context),
  private val capabilityClient: CapabilityClient = Wearable.getCapabilityClient(context)
) {
  suspend fun send(action: WatchAgentActionRequest): Boolean {
    val path = CesiumDataLayerPaths.actionPath(action.action) ?: return false
    val nodes = capabilityClient
      .getCapability(CesiumCapabilities.PHONE_RELAY, CapabilityClient.FILTER_REACHABLE)
      .await()
      .nodes
    if (nodes.isEmpty()) return false
    val payload = json.encodeToString(action).toByteArray(Charsets.UTF_8)
    nodes.forEach { node ->
      messageClient.sendMessage(node.id, path, payload).await()
    }
    return true
  }
}

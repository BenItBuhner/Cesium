package com.cesium.wear.sync

import android.content.Context
import com.cesium.wear.model.WatchAgentActionRequest
import com.cesium.wear.model.WearDataPaths
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
    val path = pathFor(action.action) ?: return false
    val nodes = capabilityClient
      .getCapability(WearDataPaths.PHONE_RELAY_CAPABILITY, CapabilityClient.FILTER_REACHABLE)
      .await()
      .nodes
    if (nodes.isEmpty()) return false
    val payload = json.encodeToString(action).toByteArray(Charsets.UTF_8)
    nodes.forEach { node ->
      messageClient.sendMessage(node.id, path, payload).await()
    }
    return true
  }

  private fun pathFor(action: String): String? =
    when (action) {
      "open_on_phone", "open" -> WearDataPaths.ACTION_OPEN_ON_PHONE
      "cancel" -> WearDataPaths.ACTION_CANCEL
      "pause" -> WearDataPaths.ACTION_PAUSE
      "resume" -> WearDataPaths.ACTION_RESUME
      "answer_question" -> WearDataPaths.ACTION_ANSWER_QUESTION
      "answer_permission" -> WearDataPaths.ACTION_ANSWER_PERMISSION
      "prompt" -> WearDataPaths.ACTION_PROMPT
      else -> null
    }
}

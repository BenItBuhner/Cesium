package com.cesium.wear.sync

import android.content.Context
import com.cesium.shared.wear.CesiumWearTransport
import com.cesium.shared.wear.PhoneRelayStatus
import com.cesium.wear.data.WatchStateStore
import com.cesium.wear.model.WatchAgentSyncEnvelope
import com.cesium.wear.model.WearDataPaths
import com.google.android.gms.wearable.DataClient
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.tasks.await
import kotlinx.serialization.json.Json

class WearDataLayerRepository(
  context: Context,
  private val stateStore: WatchStateStore = WatchStateStore(context),
  private val json: Json = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
  },
  private val dataClient: DataClient = Wearable.getDataClient(context),
  private val transport: CesiumWearTransport = CesiumWearTransport(context)
) {
  suspend fun loadInitialCompanionState() {
    val dataItems = dataClient.dataItems.await()
    try {
      for (item in dataItems) {
        if (item.uri.path == WearDataPaths.CURRENT_PROJECTION) {
          saveEnvelopeJson(DataMapItem.fromDataItem(item).dataMap.getString("json"))
        }
      }
    } finally {
      dataItems.release()
    }
  }

  suspend fun hasReachablePhoneRelay(): Boolean {
    val status = phoneRelayStatus()
    return status == PhoneRelayStatus.NEARBY || status == PhoneRelayStatus.CLOUD
  }

  suspend fun phoneRelayStatus(): PhoneRelayStatus = transport.phoneRelayStatus()

  suspend fun saveEnvelopeJson(raw: String?) {
    if (raw.isNullOrBlank()) return
    val envelope = runCatching { json.decodeFromString<WatchAgentSyncEnvelope>(raw) }.getOrNull() ?: return
    stateStore.saveEnvelope(envelope)
  }
}

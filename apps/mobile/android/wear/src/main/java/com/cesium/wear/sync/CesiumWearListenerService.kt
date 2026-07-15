package com.cesium.wear.sync

import com.cesium.wear.model.WearDataPaths
import com.cesium.wear.surface.WearAgentNotificationController
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.WearableListenerService
import kotlinx.coroutines.runBlocking

class CesiumWearListenerService : WearableListenerService() {
  override fun onDataChanged(events: DataEventBuffer) {
    super.onDataChanged(events)
    val repository = WearDataLayerRepository(applicationContext)
    try {
      for (event in events) {
        if (event.type != DataEvent.TYPE_CHANGED) continue
        val item = event.dataItem
        if (item.uri.path == WearDataPaths.CURRENT_PROJECTION) {
          val raw = DataMapItem.fromDataItem(item).dataMap.getString("json")
          runBlocking {
            repository.saveEnvelopeJson(raw)
          }
          WearAgentNotificationController(applicationContext).update(
            runBlocking { com.cesium.wear.data.WatchStateStore(applicationContext).latestEnvelope() }?.projection
          )
        }
      }
    } finally {
      events.release()
    }
  }
}

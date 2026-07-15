package com.cesium.mobile.wear

import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.WearableListenerService
import kotlin.concurrent.thread

class CesiumWearCompanionService : WearableListenerService() {
  override fun onMessageReceived(event: MessageEvent) {
    super.onMessageReceived(event)
    thread(name = "cesium-wear-action") {
      CesiumWearActionRouter(applicationContext).route(event.path, event.data)
    }
  }
}

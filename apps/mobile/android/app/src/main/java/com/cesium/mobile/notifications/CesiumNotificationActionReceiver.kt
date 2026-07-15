package com.cesium.mobile.notifications

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class CesiumNotificationActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val prefs = context.getSharedPreferences("cesium-mobile", Context.MODE_PRIVATE)
    prefs.edit()
      .putString("lastDismissedConversationId", intent.getStringExtra("conversationId"))
      .apply()
    CesiumLiveUpdateStateStore.markDismissed(
      context,
      intent.getStringExtra("runKey")
    )
    CesiumLiveUpdateStateStore.clearActive(context)
  }
}

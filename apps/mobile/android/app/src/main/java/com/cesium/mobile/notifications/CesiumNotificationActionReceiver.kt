package com.cesium.mobile.notifications

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.cesium.mobile.background.CesiumForegroundService

class CesiumNotificationActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val runKey = intent.getStringExtra("runKey")
    val prefs = context.getSharedPreferences("cesium-mobile", Context.MODE_PRIVATE)
    prefs.edit()
      .putString("lastDismissedConversationId", intent.getStringExtra("conversationId"))
      .apply()
    CesiumLiveUpdateStateStore.markDismissed(context, runKey)
    // Drop only this run; other agents keep their live notifications. The
    // service also re-anchors its foreground notification when the dismissed
    // run was the anchor.
    val stopRun = Intent(context, CesiumForegroundService::class.java).apply {
      action = CesiumForegroundService.ACTION_STOP_RUN
      putExtra("runKey", runKey)
    }
    try {
      context.startService(stopRun)
    } catch (_: IllegalStateException) {
      CesiumLiveUpdateStateStore.removeRun(context, runKey)
    }
  }
}

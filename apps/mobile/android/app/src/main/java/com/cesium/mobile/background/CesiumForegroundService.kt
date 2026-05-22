package com.cesium.mobile.background

import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import com.cesium.mobile.notifications.CesiumAgentNotification

class CesiumForegroundService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        return START_NOT_STICKY
      }
      ACTION_UPDATE, null -> {
        val notification = CesiumAgentNotification.build(this, intent?.extras ?: android.os.Bundle())
        if (Build.VERSION.SDK_INT >= 34) {
          startForeground(
            CesiumAgentNotification.NOTIFICATION_ID,
            notification,
            android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
          )
        } else {
          startForeground(CesiumAgentNotification.NOTIFICATION_ID, notification)
        }
      }
    }
    return START_STICKY
  }

  companion object {
    const val ACTION_UPDATE = "com.cesium.mobile.agent.UPDATE"
    const val ACTION_STOP = "com.cesium.mobile.agent.STOP"
  }
}

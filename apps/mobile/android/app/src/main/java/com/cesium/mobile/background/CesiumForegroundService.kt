package com.cesium.mobile.background

import android.app.Service
import android.app.NotificationManager
import android.content.Intent
import android.os.Build
import android.os.IBinder
import com.cesium.mobile.notifications.CesiumAgentNotification
import com.cesium.mobile.notifications.CesiumLiveUpdateStateStore

class CesiumForegroundService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        CesiumLiveUpdateStateStore.clearActive(this)
        stopForeground(STOP_FOREGROUND_REMOVE)
        getSystemService(NotificationManager::class.java)
          .cancel(CesiumAgentNotification.NOTIFICATION_ID)
        stopSelf()
        return START_NOT_STICKY
      }
      ACTION_UPDATE -> {
        val extras = intent.extras ?: android.os.Bundle()
        val notification = CesiumAgentNotification.build(this, extras)
        if (extras.getBoolean("ongoing", true)) {
          CesiumLiveUpdateStateStore.saveActive(this, extras)
          startAsForeground(notification)
          return START_STICKY
        }
        CesiumLiveUpdateStateStore.clearActive(this)
        stopForeground(STOP_FOREGROUND_DETACH)
        getSystemService(NotificationManager::class.java)
          .notify(CesiumAgentNotification.NOTIFICATION_ID, notification)
        stopSelf()
        return START_NOT_STICKY
      }
      null -> {
        val restored = CesiumLiveUpdateStateStore.loadActive(this)
        if (restored == null) {
          stopSelf()
          return START_NOT_STICKY
        }
        startAsForeground(CesiumAgentNotification.build(this, restored))
        return START_STICKY
      }
    }
    return START_NOT_STICKY
  }

  private fun startAsForeground(notification: android.app.Notification) {
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

  companion object {
    const val ACTION_UPDATE = "com.cesium.mobile.agent.UPDATE"
    const val ACTION_STOP = "com.cesium.mobile.agent.STOP"
  }
}

package com.cesium.mobile.background

import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import com.cesium.mobile.notifications.CesiumAgentNotification
import com.cesium.mobile.notifications.CesiumLiveUpdateStateStore

/**
 * Hosts the live notifications for every active agent run. One run's
 * notification anchors the foreground service; the rest are posted as regular
 * notifications with their own per-run ids. When the anchor run finishes, the
 * service re-anchors onto another active run before detaching, so remaining
 * agents keep their process-alive guarantee.
 */
class CesiumForegroundService : Service() {
  private var anchorRunKey: String? = null
  private var foregroundActive = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        stopAllRuns()
        return START_NOT_STICKY
      }
      ACTION_STOP_RUN -> {
        stopRun(intent.getStringExtra("runKey"))
        return if (hasActiveRuns()) START_STICKY else START_NOT_STICKY
      }
      ACTION_UPDATE -> {
        return updateRun(intent.extras ?: Bundle())
      }
      null -> {
        return restoreRuns()
      }
    }
    return START_NOT_STICKY
  }

  private fun updateRun(extras: Bundle): Int {
    val runKey = extras.getString("runKey")
    val notification = CesiumAgentNotification.build(this, extras)
    val id = CesiumAgentNotification.notificationId(runKey)

    if (extras.getBoolean("ongoing", true)) {
      CesiumLiveUpdateStateStore.saveRun(this, extras)
      if (!foregroundActive || anchorRunKey == null || anchorRunKey == runKey) {
        startAsForeground(id, notification)
        anchorRunKey = runKey
      } else {
        notificationManager().notify(id, notification)
      }
      return START_STICKY
    }

    // Terminal update: the run leaves the active set but its final
    // notification stays posted (dismissible) so completions are not lost.
    CesiumLiveUpdateStateStore.removeRun(this, runKey)
    if (foregroundActive && anchorRunKey == runKey) {
      reanchorOrDetach()
    }
    notificationManager().notify(id, notification)
    if (!hasActiveRuns()) {
      stopSelf()
      return START_NOT_STICKY
    }
    return START_STICKY
  }

  private fun stopRun(runKey: String?) {
    CesiumLiveUpdateStateStore.removeRun(this, runKey)
    if (foregroundActive && anchorRunKey == runKey) {
      val reanchored = reanchorOrDetach(removeAnchorNotification = true)
      if (!reanchored) {
        notificationManager().cancel(CesiumAgentNotification.notificationId(runKey))
      }
    } else {
      notificationManager().cancel(CesiumAgentNotification.notificationId(runKey))
    }
    if (!hasActiveRuns()) {
      stopSelf()
    }
  }

  private fun stopAllRuns() {
    val runKeys = CesiumLiveUpdateStateStore.activeRunKeys(this)
    CesiumLiveUpdateStateStore.clearActive(this)
    if (foregroundActive) {
      stopForeground(STOP_FOREGROUND_REMOVE)
      foregroundActive = false
      anchorRunKey = null
    }
    val manager = notificationManager()
    runKeys.forEach { runKey ->
      manager.cancel(CesiumAgentNotification.notificationId(runKey))
    }
    stopSelf()
  }

  private fun restoreRuns(): Int {
    // A restore happens with no JS layer alive to correct state, so only
    // recently updated runs come back; anything older is a stale leftover
    // whose elapsed chronometer would tick on for an agent that already
    // finished. The workbench reposts live runs as soon as it reconnects.
    val runs = CesiumLiveUpdateStateStore.loadRuns(this, RESTORE_MAX_AGE_MS)
    if (runs.isEmpty()) {
      stopSelf()
      return START_NOT_STICKY
    }
    val manager = notificationManager()
    runs.forEachIndexed { index, extras ->
      val runKey = extras.getString("runKey")
      val notification = CesiumAgentNotification.build(this, extras)
      val id = CesiumAgentNotification.notificationId(runKey)
      if (index == 0) {
        startAsForeground(id, notification)
        anchorRunKey = runKey
      } else {
        manager.notify(id, notification)
      }
    }
    return START_STICKY
  }

  /**
   * Moves the foreground anchor onto another active run, keeping (or
   * removing) the previous anchor's notification. Returns true when a new
   * anchor was established.
   */
  private fun reanchorOrDetach(removeAnchorNotification: Boolean = false): Boolean {
    stopForeground(
      if (removeAnchorNotification) STOP_FOREGROUND_REMOVE else STOP_FOREGROUND_DETACH
    )
    foregroundActive = false
    anchorRunKey = null
    val next = CesiumLiveUpdateStateStore.loadRuns(this).firstOrNull() ?: return false
    val nextRunKey = next.getString("runKey")
    startAsForeground(
      CesiumAgentNotification.notificationId(nextRunKey),
      CesiumAgentNotification.build(this, next)
    )
    anchorRunKey = nextRunKey
    return true
  }

  private fun hasActiveRuns(): Boolean =
    CesiumLiveUpdateStateStore.activeRunKeys(this).isNotEmpty()

  private fun notificationManager(): NotificationManager =
    getSystemService(NotificationManager::class.java)

  private fun startAsForeground(id: Int, notification: android.app.Notification) {
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(
        id,
        notification,
        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
      )
    } else {
      startForeground(id, notification)
    }
    foregroundActive = true
  }

  companion object {
    const val ACTION_UPDATE = "com.cesium.mobile.agent.UPDATE"
    const val ACTION_STOP = "com.cesium.mobile.agent.STOP"
    const val ACTION_STOP_RUN = "com.cesium.mobile.agent.STOP_RUN"

    /** Maximum age of a persisted run for the process-restart restore path. */
    const val RESTORE_MAX_AGE_MS = 30L * 60L * 1000L
  }
}

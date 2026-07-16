package com.cesium.wear.surface

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.cesium.wear.model.WatchAgentProjection

class WearAgentNotificationController(private val context: Context) {
  fun update(projection: WatchAgentProjection?) {
    if (projection == null || !projection.shouldNotify()) {
      NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
      return
    }
    ensureChannel()
    if (Build.VERSION.SDK_INT >= 33 &&
      ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      return
    }
    val builder = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setContentTitle(projection.title)
      .setContentText(projection.currentActivity)
      .setSubText(projection.progressLabel ?: projection.chip)
      .setOnlyAlertOnce(true)
      .setOngoing(projection.status == "running" || projection.pendingIntervention != null)
      .setPriority(if (projection.pendingIntervention != null) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
    val current = projection.progress
    val maximum = projection.progressMax
    if (current != null && maximum != null && maximum > 0) {
      builder.setProgress(
        maximum.toInt().coerceAtLeast(1),
        current.toInt().coerceAtLeast(0),
        false
      )
    }
    NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, builder.build())
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java)
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    manager.createNotificationChannel(
      NotificationChannel(
        CHANNEL_ID,
        "Agent runs",
        NotificationManager.IMPORTANCE_DEFAULT
      ).apply {
        description = "Cesium agent status and intervention updates"
        setShowBadge(false)
      }
    )
  }

  private fun WatchAgentProjection.shouldNotify(): Boolean =
    status == "running" ||
      status == "awaiting_permission" ||
      status == "awaiting_question" ||
      status == "failed"

  companion object {
    const val CHANNEL_ID = "cesium-wear-agent-runs"
    const val NOTIFICATION_ID = 6200
  }
}

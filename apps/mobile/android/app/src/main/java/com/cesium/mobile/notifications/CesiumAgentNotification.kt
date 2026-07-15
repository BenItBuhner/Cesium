package com.cesium.mobile.notifications

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import androidx.annotation.RequiresApi
import com.cesium.mobile.MainActivity

object CesiumAgentNotification {
  const val CHANNEL_ID = "cesium-agent-runs"
  const val NOTIFICATION_ID = 6100

  fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java)
    val existing = manager.getNotificationChannel(CHANNEL_ID)
    if (existing != null) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Agent runs",
      NotificationManager.IMPORTANCE_DEFAULT
    ).apply {
      description = "Ongoing Cesium agent task state"
      setShowBadge(false)
    }
    manager.createNotificationChannel(channel)
  }

  fun build(context: Context, extras: Bundle): Notification {
    ensureChannel(context)
    val title = extras.getString("title") ?: "Cesium agent"
    val body = extras.getString("body") ?: "Running"
    val shortText = extras.getString("shortText")
    val progressMax = extras.getInt("progressMax", 100)
    val progress = extras.getInt("progress", 0)
    val indeterminate = extras.getBoolean("indeterminate", true)
    val startedAt = extras.getLong("startedAt", System.currentTimeMillis())
    val estimatedCompletionAt = extras.getLong("estimatedCompletionAt", 0L)
    val ongoing = extras.getBoolean("ongoing", true)
    val requestPromotion = extras.getBoolean("promote", false) && ongoing

    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(context, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(context)
    }

    builder
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setContentTitle(title)
      .setContentText(body)
      .setCategory(Notification.CATEGORY_PROGRESS)
      .setOngoing(ongoing)
      .setOnlyAlertOnce(true)
      .setShowWhen(true)
      .setWhen(startedAt)
      .setContentIntent(openIntent(context, extras, "open"))
      .setDeleteIntent(deleteIntent(context, extras))

    if (Build.VERSION.SDK_INT >= 31 && ongoing) {
      builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
    }

    if (Build.VERSION.SDK_INT >= 36) {
      applyProgressStyleApi36(
        builder,
        extras,
        progressMax,
        progress,
        indeterminate
      )
      builder.setRequestPromotedOngoing(requestPromotion)
      if (shortText != null && estimatedCompletionAt <= 0L) {
        builder.setShortCriticalText(shortText)
      }
    } else {
      builder.setProgress(progressMax, progress.coerceIn(0, progressMax), indeterminate)
      if (!shortText.isNullOrBlank()) {
        builder.setSubText(shortText)
      }
    }

    if (
      estimatedCompletionAt >= System.currentTimeMillis() + MIN_COUNTDOWN_MS &&
      Build.VERSION.SDK_INT >= 24
    ) {
      builder
        .setWhen(estimatedCompletionAt)
        .setUsesChronometer(true)
        .setChronometerCountDown(true)
    } else if (startedAt > 0L && ongoing) {
      builder
        .setWhen(startedAt)
        .setUsesChronometer(true)
      if (Build.VERSION.SDK_INT >= 24) {
        builder.setChronometerCountDown(false)
      }
    }

    addAction(builder, context, extras, "open", "Open")
    val intervention = extras.getString("intervention")
    if (intervention == "permission" || intervention == "question") {
      addAction(builder, context, extras, "respond", "Respond")
    }
    if (extras.getBoolean("cancellable", false)) {
      addAction(builder, context, extras, "cancel", "Cancel")
    }

    return builder.build()
  }

  fun canPostPromoted(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < 36) return false
    val manager = context.getSystemService(NotificationManager::class.java)
    return manager.canPostPromotedNotifications()
  }

  @RequiresApi(36)
  private fun applyProgressStyleApi36(
    builder: Notification.Builder,
    extras: Bundle,
    max: Int,
    current: Int,
    indeterminate: Boolean
  ) {
    val safeMax = max.coerceIn(1, MAX_PROGRESS_SEGMENTS)
    val safeProgress = current.coerceIn(0, safeMax)
    val progressKind = extras.getString("progressKind") ?: "indeterminate"
    val style = Notification.ProgressStyle()
      .setProgressIndeterminate(indeterminate)
    if (!indeterminate) {
      style
        .setProgress(safeProgress)
        .setStyledByProgress(progressKind == "burn")
      when (progressKind) {
        "todo" -> {
          val completed = extras.getInt("todoCompleted", safeProgress)
          val currentIndex = extras.getInt("todoCurrentIndex", completed + 1)
          val segments = (1..safeMax).map { index ->
            Notification.ProgressStyle.Segment(1).setColor(
              when {
                index <= completed -> COLOR_COMPLETED
                index == currentIndex -> COLOR_ACTIVE
                else -> COLOR_PENDING
              }
            )
          }
          style.setProgressSegments(segments)
        }
        "burn" -> {
          style.setProgressSegments(
            listOf(
              Notification.ProgressStyle.Segment(safeMax).setColor(COLOR_BURN)
            )
          )
        }
      }
    }
    builder.setStyle(style)
  }

  private fun addAction(
    builder: Notification.Builder,
    context: Context,
    extras: Bundle,
    action: String,
    title: String
  ) {
    builder.addAction(
      Notification.Action.Builder(
        android.R.drawable.ic_menu_view,
        title,
        openIntent(context, extras, action)
      ).build()
    )
  }

  private fun openIntent(context: Context, extras: Bundle, action: String): PendingIntent {
    val intent = Intent(context, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      putExtra("cesiumAction", action)
      putExtra("conversationId", extras.getString("conversationId"))
      putExtra("workspaceId", extras.getString("workspaceId"))
    }
    return PendingIntent.getActivity(
      context,
      action.hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  private fun deleteIntent(context: Context, extras: Bundle): PendingIntent {
    val intent = Intent(context, CesiumNotificationActionReceiver::class.java).apply {
      action = "com.cesium.mobile.NOTIFICATION_DISMISSED"
      putExtra("runKey", extras.getString("runKey"))
      putExtra("conversationId", extras.getString("conversationId"))
      putExtra("workspaceId", extras.getString("workspaceId"))
    }
    return PendingIntent.getBroadcast(
      context,
      9001,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  private const val MIN_COUNTDOWN_MS = 2 * 60 * 1000L
  private const val MAX_PROGRESS_SEGMENTS = 100
  private val COLOR_COMPLETED = Color.rgb(88, 166, 120)
  private val COLOR_ACTIVE = Color.rgb(72, 133, 237)
  private val COLOR_PENDING = Color.rgb(120, 120, 120)
  private val COLOR_BURN = Color.rgb(229, 108, 98)
}

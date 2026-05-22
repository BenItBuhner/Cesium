package com.cesium.mobile.notifications

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
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
      .setOngoing(extras.getBoolean("ongoing", true))
      .setOnlyAlertOnce(true)
      .setShowWhen(true)
      .setWhen(startedAt)
      .setContentIntent(openIntent(context, extras, "open"))
      .setDeleteIntent(deleteIntent(context, extras))

    if (Build.VERSION.SDK_INT < 36 || !tryApplyProgressStyle(builder, progressMax, progress, indeterminate)) {
      builder.setProgress(progressMax, progress.coerceIn(0, progressMax), indeterminate)
    }

    if (shortText != null && Build.VERSION.SDK_INT >= 31) {
      tryInvoke(builder, "setShortCriticalText", arrayOf(CharSequence::class.java), arrayOf(shortText))
    }
    tryInvoke(
      builder,
      "setRequestPromotedOngoing",
      arrayOf(Boolean::class.javaPrimitiveType!!),
      arrayOf(true)
    )

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
    val manager = context.getSystemService(NotificationManager::class.java)
    return try {
      val method = manager.javaClass.getMethod("canPostPromotedNotifications")
      method.invoke(manager) as? Boolean ?: false
    } catch (_: Throwable) {
      false
    }
  }

  private fun tryApplyProgressStyle(
    builder: Notification.Builder,
    max: Int,
    current: Int,
    indeterminate: Boolean
  ): Boolean {
    return try {
      val styleClass = Class.forName("android.app.Notification\$ProgressStyle")
      val style = styleClass.getDeclaredConstructor().newInstance() as Notification.Style
      tryInvoke(style, "setStyledByProgress", arrayOf(Boolean::class.javaPrimitiveType!!), arrayOf(!indeterminate))
      tryInvoke(style, "setProgress", arrayOf(Int::class.javaPrimitiveType!!), arrayOf(current.coerceIn(0, max)))
      builder.setStyle(style)
      true
    } catch (_: Throwable) {
      false
    }
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

  private fun tryInvoke(
    target: Any,
    name: String,
    parameterTypes: Array<Class<*>>,
    values: Array<Any?>
  ) {
    try {
      val method = target.javaClass.getMethod(name, *parameterTypes)
      method.invoke(target, *values)
    } catch (_: Throwable) {
      // API-level fallback; standard notifications remain functional.
    }
  }
}

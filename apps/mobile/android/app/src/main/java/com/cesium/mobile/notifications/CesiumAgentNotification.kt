package com.cesium.mobile.notifications

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.cesium.mobile.MainActivity
import com.cesium.mobile.R
import com.cesium.shared.generated.CesiumDesignTokens
import kotlin.math.abs

object CesiumAgentNotification {
  /**
   * v2: IMPORTANCE_DEFAULT (was LOW). Only IMPORTANCE_MIN is documented as
   * disqualifying a channel from Android 16 promotion, but several OEM
   * promotion heuristics rank DEFAULT-importance channels more reliably and
   * the Live Updates guidance demos use DEFAULT. The channel itself is muted
   * (no sound / vibration), so progress reposts stay silent either way.
   * Channel importance cannot be raised in place, hence the new id.
   */
  const val CHANNEL_ID = "cesium-agent-runs-v2"
  const val LEGACY_CHANNEL_ID = "cesium-agent-runs"
  const val ALERT_CHANNEL_ID = "cesium-agent-alerts"

  /**
   * Base for per-run notification ids. Each active agent run gets its own
   * stable id so multiple agents can be tracked side by side. The range stays
   * clear of the phone-control foreground notification (0xCE72).
   */
  const val NOTIFICATION_ID_BASE = 6100
  private const val NOTIFICATION_ID_RANGE = 40_000

  fun notificationId(runKey: String?): Int {
    if (runKey.isNullOrBlank()) return NOTIFICATION_ID_BASE
    return NOTIFICATION_ID_BASE + (abs(runKey.hashCode()) % NOTIFICATION_ID_RANGE)
  }

  fun ensureChannels(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java)
    // Silent-but-DEFAULT progress channel: muting sound/vibration keeps
    // live-update reposts quiet without dropping to LOW importance, which
    // some OEM builds rank below the promotion cutoff.
    manager.createNotificationChannel(
      NotificationChannel(
        CHANNEL_ID,
        "Agent runs",
        NotificationManager.IMPORTANCE_DEFAULT
      ).apply {
        description = "Ongoing Cesium agent task state"
        setShowBadge(false)
        setSound(null, null)
        enableVibration(false)
      }
    )
    // The pre-v2 LOW-importance channel; posting stopped, so remove it from
    // the user's notification settings.
    manager.deleteNotificationChannel(LEGACY_CHANNEL_ID)
    manager.createNotificationChannel(
      NotificationChannel(
        ALERT_CHANNEL_ID,
        "Agent attention",
        NotificationManager.IMPORTANCE_HIGH
      ).apply {
        description = "An agent needs your input or finished a run"
        setShowBadge(true)
      }
    )
  }

  fun build(context: Context, extras: Bundle): Notification {
    ensureChannels(context)
    val runKey = extras.getString("runKey") ?: ""
    val title = extras.getString("title") ?: "Cesium agent"
    val body = extras.getString("body") ?: "Running"
    val shortText = extras.getString("shortText")
    val progressMax = extras.getInt("progressMax", 100)
    val progress = extras.getInt("progress", 0)
    val indeterminate = extras.getBoolean("indeterminate", true)
    val startedAt = extras.getLong("startedAt", System.currentTimeMillis())
    val estimatedCompletionAt = extras.getLong("estimatedCompletionAt", 0L)
    val ongoing = extras.getBoolean("ongoing", true)
    val alert = extras.getBoolean("alert", false)
    val requestPromotion = extras.getBoolean("promote", false) && ongoing

    val builder = NotificationCompat.Builder(
      context,
      if (alert) ALERT_CHANNEL_ID else CHANNEL_ID
    )

    builder
      .setSmallIcon(R.drawable.ic_stat_cesium)
      .setContentTitle(title)
      .setContentText(body)
      .setCategory(
        if (ongoing) Notification.CATEGORY_PROGRESS else Notification.CATEGORY_STATUS
      )
      .setOngoing(ongoing)
      .setOnlyAlertOnce(!alert)
      .setShowWhen(true)
      .setWhen(startedAt)
      .setContentIntent(openIntent(context, extras, "open"))
      .setDeleteIntent(deleteIntent(context, extras))

    if (Build.VERSION.SDK_INT >= 31 && ongoing) {
      builder.setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
    }

    val chip = resolveChipPresentation(
      shortText = shortText,
      startedAt = startedAt,
      estimatedCompletionAt = estimatedCompletionAt,
      ongoing = ongoing,
      now = System.currentTimeMillis()
    )

    if (Build.VERSION.SDK_INT >= 36) {
      applyProgressStyle(
        builder,
        extras,
        progressMax,
        progress,
        indeterminate,
        progressColors(context)
      )
      builder.setRequestPromotedOngoing(requestPromotion)
      if (chip.shortCriticalText != null) {
        builder.setShortCriticalText(chip.shortCriticalText)
      }
    } else {
      if (ongoing) {
        builder.setProgress(progressMax, progress.coerceIn(0, progressMax), indeterminate)
      }
      if (!shortText.isNullOrBlank()) {
        builder.setSubText(shortText)
      }
    }

    if (chip.countdownTo != null && Build.VERSION.SDK_INT >= 24) {
      builder
        .setWhen(chip.countdownTo)
        .setUsesChronometer(true)
        .setChronometerCountDown(true)
    } else if (chip.countUpFrom != null) {
      builder
        .setWhen(chip.countUpFrom)
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
    return NotificationManagerCompat.from(context).canPostPromotedNotifications()
  }

  /**
   * Whether the given notification structurally qualifies for Android 16
   * promotion (ongoing + title + eligible style + promotion requested, no
   * group summary / custom views / colorization). Ignores the user's
   * per-app Live Updates permission — pair with [canPostPromoted].
   */
  fun hasPromotableCharacteristics(notification: Notification): Boolean {
    if (Build.VERSION.SDK_INT < 36) return false
    return try {
      notification.hasPromotableCharacteristics()
    } catch (_: Throwable) {
      false
    }
  }

  /**
   * True when any currently posted Cesium notification was actually promoted
   * by the system (FLAG_PROMOTED_ONGOING) — the ground truth for "is a live
   * update rendering right now".
   */
  fun isPromotedOngoingPosted(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < 36) return false
    return try {
      context.getSystemService(NotificationManager::class.java)
        .activeNotifications
        .any { it.notification.flags and Notification.FLAG_PROMOTED_ONGOING != 0 }
    } catch (_: Throwable) {
      false
    }
  }

  private fun applyProgressStyle(
    builder: NotificationCompat.Builder,
    extras: Bundle,
    max: Int,
    current: Int,
    indeterminate: Boolean,
    colors: CesiumProgressColors
  ) {
    val safeMax = max.coerceIn(1, MAX_PROGRESS_SEGMENTS)
    val safeProgress = current.coerceIn(0, safeMax)
    val progressKind = extras.getString("progressKind") ?: "indeterminate"
    val style = NotificationCompat.ProgressStyle()
      .setProgressIndeterminate(indeterminate)
    if (!indeterminate) {
      style
        .setProgress(safeProgress)
        .setStyledByProgress(progressKind == "goal")
      when (progressKind) {
        "todo" -> {
          val completed = extras.getInt("todoCompleted", safeProgress)
          val currentIndex = extras.getInt("todoCurrentIndex", completed + 1)
          val segments = (1..safeMax).map { index ->
            NotificationCompat.ProgressStyle.Segment(1).setColor(
              when {
                index <= completed -> colors.completed
                index == currentIndex -> colors.active
                else -> colors.pending
              }
            )
          }
          style.setProgressSegments(segments)
        }
        "goal" -> {
          style.setProgressSegments(
            listOf(
              NotificationCompat.ProgressStyle.Segment(safeMax).setColor(colors.goal)
            )
          )
        }
        // Terminal and any unknown determinate kind get one explicit segment
        // so every posted ProgressStyle carries a well-formed track instead
        // of relying on platform defaults.
        else -> {
          style.setProgressSegments(
            listOf(
              NotificationCompat.ProgressStyle.Segment(safeMax).setColor(
                if (safeProgress >= safeMax) colors.completed else colors.pending
              )
            )
          )
        }
      }
    }
    builder.setStyle(style)
  }

  private fun addAction(
    builder: NotificationCompat.Builder,
    context: Context,
    extras: Bundle,
    action: String,
    title: String
  ) {
    builder.addAction(
      NotificationCompat.Action.Builder(
        android.R.drawable.ic_menu_view,
        title,
        openIntent(context, extras, action)
      ).build()
    )
  }

  private fun openIntent(context: Context, extras: Bundle, action: String): PendingIntent {
    val runKey = extras.getString("runKey") ?: ""
    val intent = Intent(context, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      putExtra("cesiumAction", action)
      putExtra("runKey", runKey)
      putExtra("conversationId", extras.getString("conversationId"))
      putExtra("workspaceId", extras.getString("workspaceId"))
    }
    // Request codes must differ per run AND per action, otherwise concurrent
    // agent notifications overwrite each other's intent extras via
    // FLAG_UPDATE_CURRENT and every tap lands on the same conversation.
    return PendingIntent.getActivity(
      context,
      requestCode(runKey, action),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  private fun deleteIntent(context: Context, extras: Bundle): PendingIntent {
    val runKey = extras.getString("runKey") ?: ""
    val intent = Intent(context, CesiumNotificationActionReceiver::class.java).apply {
      action = "com.cesium.mobile.NOTIFICATION_DISMISSED"
      putExtra("runKey", runKey)
      putExtra("conversationId", extras.getString("conversationId"))
      putExtra("workspaceId", extras.getString("workspaceId"))
    }
    return PendingIntent.getBroadcast(
      context,
      requestCode(runKey, "dismiss"),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  private fun requestCode(runKey: String, action: String): Int =
    abs("$runKey:$action".hashCode())

  private fun progressColors(context: Context): CesiumProgressColors {
    val dark =
      context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
        Configuration.UI_MODE_NIGHT_YES
    return if (dark) {
      resolveCesiumProgressColors(true)
    } else {
      resolveCesiumProgressColors(false)
    }
  }

  private const val MAX_PROGRESS_SEGMENTS = 100
}

internal const val MIN_COUNTDOWN_MS = 2 * 60 * 1000L

/**
 * What occupies the status-bar chip of a promoted live update. Exactly one
 * time source is active (a countdown to the ETA, or elapsed time since the
 * run started), and short critical text is set whenever no countdown owns
 * the chip — previously any ETA (even one below the countdown floor)
 * suppressed the text, leaving an icon-only chip.
 */
internal data class CesiumChipPresentation(
  /** Chronometer counting down to the estimated completion time. */
  val countdownTo: Long?,
  /** Elapsed-time chronometer anchored at the run start. */
  val countUpFrom: Long?,
  /** Status-bar chip text; null while a countdown occupies the chip. */
  val shortCriticalText: String?
)

internal fun resolveChipPresentation(
  shortText: String?,
  startedAt: Long,
  estimatedCompletionAt: Long,
  ongoing: Boolean,
  now: Long
): CesiumChipPresentation {
  val text = shortText?.takeIf { it.isNotBlank() }
  if (estimatedCompletionAt >= now + MIN_COUNTDOWN_MS) {
    // The countdown owns the chip; short critical text would override it.
    return CesiumChipPresentation(
      countdownTo = estimatedCompletionAt,
      countUpFrom = null,
      shortCriticalText = null
    )
  }
  if (ongoing && startedAt > 0L) {
    return CesiumChipPresentation(
      countdownTo = null,
      countUpFrom = startedAt,
      shortCriticalText = text
    )
  }
  return CesiumChipPresentation(
    countdownTo = null,
    countUpFrom = null,
    shortCriticalText = text
  )
}

internal data class CesiumProgressColors(
  val completed: Int,
  val active: Int,
  val pending: Int,
  val goal: Int
)

internal fun resolveCesiumProgressColors(dark: Boolean): CesiumProgressColors =
  if (dark) {
    CesiumProgressColors(
      completed = CesiumDesignTokens.Dark.AskAccent.toInt(),
      active = CesiumDesignTokens.Dark.WorkflowAccent.toInt(),
      pending = CesiumDesignTokens.Dark.TextSecondary.toInt(),
      goal = CesiumDesignTokens.Dark.GoalAccent.toInt()
    )
  } else {
    CesiumProgressColors(
      completed = CesiumDesignTokens.Light.AskAccent.toInt(),
      active = CesiumDesignTokens.Light.WorkflowAccent.toInt(),
      pending = CesiumDesignTokens.Light.TextSecondary.toInt(),
      goal = CesiumDesignTokens.Light.GoalAccent.toInt()
    )
  }

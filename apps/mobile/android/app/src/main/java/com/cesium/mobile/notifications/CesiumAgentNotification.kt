package com.cesium.mobile.notifications

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.cesium.mobile.MainActivity
import com.cesium.mobile.R
import kotlin.math.abs

/**
 * Builds the two agent notifications the JS controller posts:
 *
 * - the single consolidated LIVE notification (ongoing) - a lone run in full
 *   detail or "N agents running" with one line per agent, and
 * - a COMPLETION card per finished run (dismissible) - diffstat, outcome, and
 *   Review / View PR actions.
 *
 * Both render their multi-line body with [NotificationCompat.BigTextStyle],
 * which is one of the styles Android 16 promotes to a Live Update (the status
 * bar chip / lock screen / Samsung Now Bar). InboxStyle would fit a list too
 * but is not promotable, so lines travel as one "\n"-joined string instead.
 */
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
   * Base for notification ids. The live notification and every completion
   * card hash their run key onto a stable id so updates land in place and the
   * cards of different runs sit side by side. The range stays clear of the
   * phone-control foreground notification (0xCE72).
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
    val expandedBody = extras.getString("expandedBody")
    val subText = extras.getString("subText")
    val shortText = extras.getString("shortText")
    val startedAt = extras.getLong("startedAt", System.currentTimeMillis())
    val completedAt = extras.getLong("completedAt", 0L)
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
      .setStyle(
        NotificationCompat.BigTextStyle().bigText(resolveExpandedText(body, expandedBody))
      )
      .setCategory(
        if (ongoing) Notification.CATEGORY_PROGRESS else Notification.CATEGORY_STATUS
      )
      .setOngoing(ongoing)
      .setOnlyAlertOnce(!alert)
      .setShowWhen(true)
      // A completion card is stamped with when the run ended; the live
      // notification with when it started (the chronometer anchor below).
      .setWhen(resolveNotificationWhen(startedAt, completedAt, ongoing))
      .setContentIntent(openIntent(context, extras, if (ongoing) "open" else "review"))
      .setDeleteIntent(deleteIntent(context, extras))

    if (Build.VERSION.SDK_INT >= 31 && ongoing) {
      builder.setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
    }

    resolveHeaderSubText(
      subText = subText,
      shortText = shortText,
      ongoing = ongoing,
      sdkInt = Build.VERSION.SDK_INT
    )?.let { builder.setSubText(it) }

    val chip = resolveChipPresentation(
      shortText = shortText,
      startedAt = startedAt,
      ongoing = ongoing
    )

    if (Build.VERSION.SDK_INT >= 36) {
      builder.setRequestPromotedOngoing(requestPromotion)
      if (chip.shortCriticalText != null) {
        builder.setShortCriticalText(chip.shortCriticalText)
      }
    } else if (ongoing) {
      // Pre-16 shade: a determinate bar for structured progress (todo fraction
      // or goal percent). Nothing spins for runs without it - the chronometer
      // already says the run is alive.
      val progressMax = extras.getInt("progressMax", 0)
      if (extras.containsKey("progress") && progressMax > 0) {
        builder.setProgress(
          progressMax,
          extras.getInt("progress", 0).coerceIn(0, progressMax),
          false
        )
      }
    }

    if (chip.countUpFrom != null) {
      builder
        .setWhen(chip.countUpFrom)
        .setUsesChronometer(true)
      if (Build.VERSION.SDK_INT >= 24) {
        builder.setChronometerCountDown(false)
      }
    }

    if (ongoing) {
      addLiveActions(builder, context, extras)
    } else {
      addCompletionActions(builder, context, extras)
    }

    return builder.build()
  }

  private fun addLiveActions(
    builder: NotificationCompat.Builder,
    context: Context,
    extras: Bundle
  ) {
    addAction(builder, context, extras, "open", "Open")
    val intervention = extras.getString("intervention")
    val hasPermissionQuickActions =
      intervention == "permission" &&
        !extras.getString("permissionRequestId").isNullOrBlank() &&
        !extras.getString("permissionAllowOptionId").isNullOrBlank()
    val hasQuestionReply =
      intervention == "question" && !extras.getString("questionId").isNullOrBlank()
    when {
      // One-tap permission answers straight from the shade. Android renders at
      // most three actions, so Allow/Deny take the two remaining slots; the
      // run can still be cancelled after opening the app.
      hasPermissionQuickActions -> {
        addQuickAction(builder, context, extras, "allow_permission", "Allow")
        if (!extras.getString("permissionDenyOptionId").isNullOrBlank()) {
          addQuickAction(builder, context, extras, "deny_permission", "Deny")
        }
      }
      hasQuestionReply -> {
        addReplyAction(builder, context, extras)
        if (extras.getBoolean("cancellable", false)) {
          addAction(builder, context, extras, "cancel", "Cancel")
        }
      }
      // Older web bundles do not ship the quick-action ids; fall back to a
      // Respond button that just opens the conversation.
      intervention == "permission" || intervention == "question" -> {
        addAction(builder, context, extras, "respond", "Respond")
        if (extras.getBoolean("cancellable", false)) {
          addAction(builder, context, extras, "cancel", "Cancel")
        }
      }
      else -> {
        if (extras.getBoolean("cancellable", false)) {
          addAction(builder, context, extras, "cancel", "Cancel")
        }
      }
    }
  }

  /** Review opens the finished conversation; View PR opens the pull request the run reported. */
  private fun addCompletionActions(
    builder: NotificationCompat.Builder,
    context: Context,
    extras: Bundle
  ) {
    addAction(builder, context, extras, "review", "Review")
    val pullRequestUrl = extras.getString("pullRequestUrl")
    if (isOpenableHttpUrl(pullRequestUrl)) {
      builder.addAction(
        NotificationCompat.Action.Builder(
          android.R.drawable.ic_menu_view,
          "View PR",
          viewUrlIntent(context, extras, "view_pr", pullRequestUrl!!)
        ).build()
      )
    }
  }

  fun canPostPromoted(context: Context): Boolean {
    return NotificationManagerCompat.from(context).canPostPromotedNotifications()
  }

  /**
   * Whether the given notification structurally qualifies for Android 16
   * promotion (ongoing + title + eligible style + promotion requested, no
   * group summary / custom views / colorization). Ignores the user's
   * per-app Live Updates permission - pair with [canPostPromoted].
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
   * by the system (FLAG_PROMOTED_ONGOING) - the ground truth for "is a live
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

  /**
   * Action answered in the background by [CesiumNotificationQuickActionReceiver]
   * (HTTP call against the workbench server) - the app never opens.
   */
  private fun addQuickAction(
    builder: NotificationCompat.Builder,
    context: Context,
    extras: Bundle,
    quickAction: String,
    title: String
  ) {
    builder.addAction(
      NotificationCompat.Action.Builder(
        android.R.drawable.ic_menu_view,
        title,
        quickActionIntent(context, extras, quickAction, mutable = false)
      ).build()
    )
  }

  /** Inline reply for a pending agent question, answered without opening the app. */
  private fun addReplyAction(
    builder: NotificationCompat.Builder,
    context: Context,
    extras: Bundle
  ) {
    val remoteInput = androidx.core.app.RemoteInput.Builder(REMOTE_INPUT_KEY)
      .setLabel("Answer")
      .build()
    builder.addAction(
      NotificationCompat.Action.Builder(
        android.R.drawable.ic_menu_send,
        "Reply",
        // RemoteInput results are appended by the system, so the intent must
        // be mutable (mandatory distinction since Android 12).
        quickActionIntent(context, extras, "reply_question", mutable = true)
      )
        .addRemoteInput(remoteInput)
        .setAllowGeneratedReplies(false)
        .build()
    )
  }

  private fun quickActionIntent(
    context: Context,
    extras: Bundle,
    quickAction: String,
    mutable: Boolean
  ): PendingIntent {
    val runKey = extras.getString("runKey") ?: ""
    val intent = Intent(context, CesiumNotificationQuickActionReceiver::class.java).apply {
      action = CesiumNotificationQuickActionReceiver.ACTION_QUICK_ACTION
      // Carry the FULL payload so the receiver can repost an updated
      // notification (and keep the state store coherent) after answering.
      putExtras(extras)
      putExtra("quickAction", quickAction)
    }
    // RemoteInput needs a mutable PendingIntent on EVERY API level: the
    // system appends the typed reply to the intent. FLAG_MUTABLE only exists
    // since 31; before that "no flag" is mutable, and passing FLAG_IMMUTABLE
    // (added in 23) silently prevents the reply from ever being attached.
    val mutabilityFlag =
      when {
        !mutable -> PendingIntent.FLAG_IMMUTABLE
        Build.VERSION.SDK_INT >= 31 -> PendingIntent.FLAG_MUTABLE
        else -> 0
      }
    return PendingIntent.getBroadcast(
      context,
      requestCode(runKey, quickAction),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or mutabilityFlag
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
    // completion cards overwrite each other's intent extras via
    // FLAG_UPDATE_CURRENT and every tap lands on the same conversation.
    return PendingIntent.getActivity(
      context,
      requestCode(runKey, action),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  /** Opens an external URL (the run's pull request) in the system browser. */
  private fun viewUrlIntent(
    context: Context,
    extras: Bundle,
    action: String,
    url: String
  ): PendingIntent {
    val runKey = extras.getString("runKey") ?: ""
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
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

  /** RemoteInput result key for the inline question reply. */
  const val REMOTE_INPUT_KEY = "cesium_remote_reply"
}

/**
 * What occupies the status-bar chip of a promoted live update. Concrete
 * progress text (todo fraction "3/7", goal percent, or a status word like
 * INPUT) always owns the chip when present; the elapsed-time chronometer is
 * the fallback face for runs (and the multi-agent list) with nothing better
 * to show. ETA countdowns were removed on purpose: extrapolated completion
 * times for volatile todo lists were wrong often enough to be noise.
 */
internal data class CesiumChipPresentation(
  /** Elapsed-time chronometer anchored at the run start. */
  val countUpFrom: Long?,
  /** Status-bar chip text; shown in preference to the chronometer. */
  val shortCriticalText: String?
)

internal fun resolveChipPresentation(
  shortText: String?,
  startedAt: Long,
  ongoing: Boolean
): CesiumChipPresentation {
  val text = shortText?.takeIf { it.isNotBlank() }
  if (ongoing && startedAt > 0L) {
    return CesiumChipPresentation(
      countUpFrom = startedAt,
      shortCriticalText = text
    )
  }
  return CesiumChipPresentation(
    countUpFrom = null,
    shortCriticalText = text
  )
}

/**
 * The expanded (BigTextStyle) body: the multi-line payload when the JS layer
 * sent one, otherwise the collapsed line so older payloads still expand to
 * something.
 */
internal fun resolveExpandedText(body: String, expandedBody: String?): String =
  expandedBody?.takeIf { it.isNotBlank() } ?: body

/**
 * Header sub text ("Cesium · Finished · 3:06 PM"). A completion card names
 * its outcome; a live notification on the pre-16 shade shows the progress
 * text there because that build has no status-bar chip to carry it. On
 * Android 16+ the chip owns the progress text and the header stays clean.
 */
internal fun resolveHeaderSubText(
  subText: String?,
  shortText: String?,
  ongoing: Boolean,
  sdkInt: Int
): String? {
  val status = subText?.takeIf { it.isNotBlank() }
  if (status != null) return status
  if (ongoing && sdkInt < 36) return shortText?.takeIf { it.isNotBlank() }
  return null
}

/** Timestamp shown in the header: the run's end for completion cards, its start otherwise. */
internal fun resolveNotificationWhen(startedAt: Long, completedAt: Long, ongoing: Boolean): Long =
  if (!ongoing && completedAt > 0L) completedAt else startedAt

/** Only web URLs get a View PR action; anything else would be an intent the shade cannot open. */
internal fun isOpenableHttpUrl(url: String?): Boolean {
  if (url.isNullOrBlank()) return false
  val trimmed = url.trim()
  return trimmed.startsWith("https://", ignoreCase = true) ||
    trimmed.startsWith("http://", ignoreCase = true)
}

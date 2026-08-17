package com.cesium.mobile.notifications

import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import com.cesium.mobile.CesiumNotificationIntentStore
import com.cesium.mobile.background.CesiumForegroundService
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap

/**
 * Android Live Updates (promoted ongoing notifications) are the primary
 * delivery surface. Samsung's Now Bar has no third-party API of its own —
 * One UI 8+ renders these same standard Live Updates in the Now Bar — so the
 * only real fallback is a plain ongoing notification, which the system
 * applies automatically whenever promotion is unsupported or denied.
 */
internal const val LIVE_UPDATE_PREFERENCE_LIVE = "live"
internal const val LIVE_UPDATE_PREFERENCE_BASIC = "basic"
internal const val LIVE_UPDATE_PREFERENCE_OFF = "off"

/** Value stored by builds that exposed a separate "Now Bar" placement. */
internal const val LEGACY_LIVE_UPDATE_PREFERENCE_NOW_BAR = "nowbar"

internal fun normalizeLiveUpdatePreference(preference: String?): String =
  when (preference) {
    LIVE_UPDATE_PREFERENCE_LIVE,
    LIVE_UPDATE_PREFERENCE_BASIC,
    LIVE_UPDATE_PREFERENCE_OFF -> preference
    // Legacy "nowbar" requested promotion with fallback, which is exactly
    // what "live" means now.
    LEGACY_LIVE_UPDATE_PREFERENCE_NOW_BAR -> LIVE_UPDATE_PREFERENCE_LIVE
    else -> LIVE_UPDATE_PREFERENCE_LIVE
  }

/**
 * Maps a value stored under the legacy preference key onto the new value set.
 * Legacy "live" meant "never request promotion", which is now "basic".
 */
internal fun migrateLegacyLiveUpdatePreference(legacy: String?): String? =
  when (legacy) {
    LEGACY_LIVE_UPDATE_PREFERENCE_NOW_BAR -> LIVE_UPDATE_PREFERENCE_LIVE
    "live" -> LIVE_UPDATE_PREFERENCE_BASIC
    LIVE_UPDATE_PREFERENCE_OFF -> LIVE_UPDATE_PREFERENCE_OFF
    else -> null
  }

internal fun isSamsungDevice(manufacturer: String?): Boolean =
  manufacturer?.trim()?.equals("samsung", ignoreCase = true) == true

/**
 * Alert behavior modes for agent notifications: surface always, only while
 * the app is in the background, or never. Enforcement lives in the JS
 * controller (it knows the AppState); native only persists the choice.
 */
internal const val ALERT_MODE_ALWAYS = "always"
internal const val ALERT_MODE_BACKGROUND = "background"
internal const val ALERT_MODE_OFF = "off"

/** Completions default to background-only: finishing while the user is inside the app stays quiet. */
internal const val DEFAULT_COMPLETION_ALERT_MODE = ALERT_MODE_BACKGROUND

/** Needs-input alerts default to always: a blocked agent needs the user either way. */
internal const val DEFAULT_INTERVENTION_ALERT_MODE = ALERT_MODE_ALWAYS

internal fun normalizeAlertMode(value: String?, default: String): String =
  when (value) {
    ALERT_MODE_ALWAYS,
    ALERT_MODE_BACKGROUND,
    ALERT_MODE_OFF -> value
    else -> default
  }

/**
 * Which runs may surface a time estimate. "goal" (default) restricts the ETA
 * countdown to goal runs — todo plans are short and their per-task complexity
 * varies too much for extrapolated estimates to mean anything, so those runs
 * show the todo progression instead.
 */
internal const val ETA_MODE_GOAL = "goal"
internal const val ETA_MODE_ALWAYS = "always"
internal const val ETA_MODE_OFF = "off"

internal fun normalizeEtaMode(value: String?): String =
  when (value) {
    ETA_MODE_GOAL,
    ETA_MODE_ALWAYS,
    ETA_MODE_OFF -> value
    else -> ETA_MODE_GOAL
  }

/** Concurrent runs: one notification each, or a single aggregated one. */
internal const val MULTI_AGENT_SEPARATE = "separate"
internal const val MULTI_AGENT_COMBINED = "combined"

internal fun normalizeMultiAgentMode(value: String?): String =
  when (value) {
    MULTI_AGENT_SEPARATE,
    MULTI_AGENT_COMBINED -> value
    else -> MULTI_AGENT_SEPARATE
  }

/**
 * Whether this Android build actually RENDERS promoted live updates.
 * Base Android 16 (SDK 36.0) shipped the Live Update APIs without the
 * system UI: canPostPromotedNotifications() reports false and no status-bar
 * chip exists, so notifications silently fall back to the standard shade.
 * Rendering arrived in Android 16 QPR1 (a minor SDK release above the 36
 * base) — and, independently, Samsung One UI 8 renders promoted
 * notifications in the Now Bar on base 36.
 */
internal fun isPromotionRenderCapable(
  sdkInt: Int,
  hasMinorSdkAboveBase: Boolean,
  samsung: Boolean
): Boolean = sdkInt > 36 || (sdkInt == 36 && (hasMinorSdkAboveBase || samsung))

class CesiumLiveUpdatesModule(
  private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "CesiumLiveUpdates"

  @ReactMethod
  fun startOrUpdate(payload: ReadableMap, promise: Promise) {
    val extras = payload.toBundle()
    val preference = deliveryPreference()
    if (preference == LIVE_UPDATE_PREFERENCE_OFF) {
      stopAllLiveUpdates()
      promise.resolve(statusMap())
      return
    }
    // Promotion requires both the user preference AND the payload's consent
    // (terminal updates arrive with promote=false); previously the payload
    // flag was silently overwritten.
    extras.putBoolean(
      "promote",
      extras.getBoolean("promote", true) && preference == LIVE_UPDATE_PREFERENCE_LIVE
    )
    val runKey = extras.getString("runKey")
    val alert = extras.getBoolean("alert", false)
    // A dismissed run stays quiet for progress updates, but interventions and
    // completions still surface — those need the user, not the other way
    // around.
    if (!alert && CesiumLiveUpdateStateStore.wasDismissed(reactContext, runKey)) {
      promise.resolve(statusMap(suppressedByDismissal = true))
      return
    }
    val intent = Intent(reactContext, CesiumForegroundService::class.java).apply {
      action = CesiumForegroundService.ACTION_UPDATE
      putExtras(extras)
    }
    if (
      extras.getBoolean("ongoing", true) &&
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
    ) {
      try {
        reactContext.startForegroundService(intent)
      } catch (_: IllegalStateException) {
        // Foreground-service start restrictions (app in background) must not
        // drop the update — the notification itself needs no service.
        notifyDirectly(extras)
      }
    } else {
      try {
        reactContext.startService(intent)
      } catch (_: IllegalStateException) {
        notifyDirectly(extras)
      }
    }
    promise.resolve(statusMap())
  }

  @ReactMethod
  fun stopRun(runKey: String, promise: Promise) {
    val intent = Intent(reactContext, CesiumForegroundService::class.java).apply {
      action = CesiumForegroundService.ACTION_STOP_RUN
      putExtra("runKey", runKey)
    }
    try {
      reactContext.startService(intent)
    } catch (_: IllegalStateException) {
      CesiumLiveUpdateStateStore.removeRun(reactContext, runKey)
      reactContext.getSystemService(NotificationManager::class.java)
        .cancel(CesiumAgentNotification.notificationId(runKey))
    }
    promise.resolve(null)
  }

  @ReactMethod
  fun stop(promise: Promise) {
    stopAllLiveUpdates()
    promise.resolve(null)
  }

  private fun stopAllLiveUpdates() {
    val runKeys = CesiumLiveUpdateStateStore.activeRunKeys(reactContext)
    CesiumLiveUpdateStateStore.clearActive(reactContext)
    val intent = Intent(reactContext, CesiumForegroundService::class.java).apply {
      action = CesiumForegroundService.ACTION_STOP
    }
    reactContext.stopService(intent)
    val manager = reactContext.getSystemService(NotificationManager::class.java)
    runKeys.forEach { runKey ->
      manager.cancel(CesiumAgentNotification.notificationId(runKey))
    }
  }

  private fun notifyDirectly(extras: Bundle) {
    if (extras.getBoolean("ongoing", true)) {
      // Keep the run restorable even when the service could not be started
      // (background start restrictions); otherwise a process restart drops
      // the notification entirely.
      CesiumLiveUpdateStateStore.saveRun(reactContext, extras)
    } else {
      CesiumLiveUpdateStateStore.removeRun(reactContext, extras.getString("runKey"))
    }
    reactContext.getSystemService(NotificationManager::class.java).notify(
      CesiumAgentNotification.notificationId(extras.getString("runKey")),
      CesiumAgentNotification.build(reactContext, extras)
    )
  }

  @ReactMethod
  fun getPromotionStatus(promise: Promise) {
    promise.resolve(statusMap())
  }

  @ReactMethod
  fun getDeliveryPreference(promise: Promise) {
    promise.resolve(deliveryPreference())
  }

  @ReactMethod
  fun setDeliveryPreference(preference: String, promise: Promise) {
    val normalized = normalizeLiveUpdatePreference(preference)
    reactContext
      .getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_DELIVERY_PREFERENCE, normalized)
      .apply()
    if (normalized == LIVE_UPDATE_PREFERENCE_OFF) {
      stopAllLiveUpdates()
    }
    promise.resolve(statusMap())
  }

  @ReactMethod
  fun setDisplayPreferences(preferences: ReadableMap, promise: Promise) {
    val eta = normalizeEtaMode(
      if (preferences.hasKey("eta")) preferences.getString("eta") else null
    )
    val multiAgent = normalizeMultiAgentMode(
      if (preferences.hasKey("multiAgent")) preferences.getString("multiAgent") else null
    )
    reactContext
      .getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_ETA_MODE, eta)
      .putString(KEY_MULTI_AGENT_MODE, multiAgent)
      .apply()
    promise.resolve(statusMap())
  }

  @ReactMethod
  fun setAlertPreferences(preferences: ReadableMap, promise: Promise) {
    val completion = normalizeAlertMode(
      if (preferences.hasKey("completion")) preferences.getString("completion") else null,
      DEFAULT_COMPLETION_ALERT_MODE
    )
    val intervention = normalizeAlertMode(
      if (preferences.hasKey("intervention")) preferences.getString("intervention") else null,
      DEFAULT_INTERVENTION_ALERT_MODE
    )
    reactContext
      .getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_COMPLETION_ALERT_MODE, completion)
      .putString(KEY_INTERVENTION_ALERT_MODE, intervention)
      .apply()
    promise.resolve(statusMap())
  }

  /**
   * Run keys of every natively persisted ongoing run. The JS controller
   * reconciles these against its authoritative projection set and stops any
   * stale leftovers (e.g. runs restored by the foreground service for agents
   * that finished while the app process was dead).
   */
  @ReactMethod
  fun getActiveRunKeys(promise: Promise) {
    val array = Arguments.createArray()
    CesiumLiveUpdateStateStore.activeRunKeys(reactContext).forEach { array.pushString(it) }
    promise.resolve(array)
  }

  @ReactMethod
  fun openPromotionSettings(promise: Promise) {
    if (Build.VERSION.SDK_INT < 36) {
      promise.resolve(false)
      return
    }
    val intent = Intent(Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS).apply {
      putExtra(Settings.EXTRA_APP_PACKAGE, reactContext.packageName)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    val available = intent.resolveActivity(reactContext.packageManager) != null
    if (available) {
      reactContext.startActivity(intent)
    }
    promise.resolve(available)
  }

  /**
   * Best-effort deep link into Samsung's Now Bar settings (Lock screen and
   * AOD → Now bar). There is no documented public intent, so each candidate
   * is resolve-guarded; when none exists the app's notification settings
   * open instead (where One UI hosts the per-app "Live notifications"
   * toggle). Resolves with the surface that opened, or null.
   */
  @ReactMethod
  fun openNowBarSettings(promise: Promise) {
    val nowBarCandidates = listOf(
      // Samsung ships its settings screens inside com.android.settings with
      // com.samsung.android.settings.* class names.
      Intent().setComponent(
        ComponentName(
          "com.android.settings",
          "com.samsung.android.settings.lockscreen.NowBarSettingsActivity"
        )
      ),
      Intent("com.samsung.android.settings.NOW_BAR_SETTINGS")
    )
    for (candidate in nowBarCandidates) {
      candidate.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      if (candidate.resolveActivity(reactContext.packageManager) == null) continue
      try {
        reactContext.startActivity(candidate)
        promise.resolve("nowbar")
        return
      } catch (_: Exception) {
        // Fall through to the next candidate.
      }
    }
    val fallback = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
      putExtra(Settings.EXTRA_APP_PACKAGE, reactContext.packageName)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    if (fallback.resolveActivity(reactContext.packageManager) != null) {
      try {
        reactContext.startActivity(fallback)
        promise.resolve("appNotificationSettings")
        return
      } catch (_: Exception) {
        // Nothing openable.
      }
    }
    promise.resolve(null)
  }

  @ReactMethod
  fun consumeInitialNotificationAction(promise: Promise) {
    val intent = CesiumNotificationIntentStore.consume()
    val map = Arguments.createMap()
    if (intent != null) {
      map.putString("actionId", intent.getStringExtra("cesiumAction"))
      map.putString("conversationId", intent.getStringExtra("conversationId"))
      map.putString("workspaceId", intent.getStringExtra("workspaceId"))
    }
    promise.resolve(map)
  }

  private fun statusMap(suppressedByDismissal: Boolean = false) = Arguments.createMap().apply {
    val samsung = isSamsungDevice(Build.MANUFACTURER)
    putInt("sdkInt", Build.VERSION.SDK_INT)
    putBoolean("progressStyleSupported", Build.VERSION.SDK_INT >= 36)
    putBoolean("canPostPromotedNotifications", CesiumAgentNotification.canPostPromoted(reactContext))
    putBoolean("notificationPermissionGranted", notificationsEnabled())
    putBoolean("suppressedByDismissal", suppressedByDismissal)
    putString("deliveryPreference", deliveryPreference())
    putMap(
      "alertPreferences",
      Arguments.createMap().apply {
        putString("completion", completionAlertMode())
        putString("intervention", interventionAlertMode())
      }
    )
    putMap(
      "displayPreferences",
      Arguments.createMap().apply {
        putString("eta", etaMode())
        putString("multiAgent", multiAgentMode())
      }
    )
    // Promotion diagnostics: whether this Android build can render promoted
    // live updates at all, whether our notifications structurally qualify,
    // and whether one is promoted right now.
    putBoolean("isSamsung", samsung)
    putBoolean(
      "promotionRenderSupported",
      isPromotionRenderCapable(Build.VERSION.SDK_INT, hasMinorSdkAboveBase(), samsung)
    )
    putBoolean("hasPromotableCharacteristics", samplePromotableCharacteristics())
    putBoolean(
      "promotedNotificationPosted",
      CesiumAgentNotification.isPromotedOngoingPosted(reactContext)
    )
  }

  /**
   * True on Android 16 minor releases (QPR1+), where the Live Update system
   * UI actually exists. SDK_INT_FULL was added in API 36, so the read is
   * guarded and failure-tolerant.
   */
  private fun hasMinorSdkAboveBase(): Boolean {
    if (Build.VERSION.SDK_INT != 36) return false
    return try {
      Build.VERSION.SDK_INT_FULL > Build.VERSION_CODES_FULL.BAKLAVA
    } catch (_: Throwable) {
      false
    }
  }

  /**
   * Builds a representative ongoing run notification and asks the platform
   * whether it structurally qualifies for promotion. Nothing is posted.
   */
  private fun samplePromotableCharacteristics(): Boolean {
    if (Build.VERSION.SDK_INT < 36) return false
    return try {
      val sample = Bundle().apply {
        putString("runKey", "cesium-promotion-diagnostic")
        putString("title", "Cesium agent")
        putString("body", "Diagnostic")
        putBoolean("ongoing", true)
        putBoolean("promote", true)
        putBoolean("indeterminate", true)
      }
      CesiumAgentNotification.hasPromotableCharacteristics(
        CesiumAgentNotification.build(reactContext, sample)
      )
    } catch (_: Throwable) {
      false
    }
  }

  private fun deliveryPreference(): String {
    val prefs = reactContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    val stored = prefs.getString(KEY_DELIVERY_PREFERENCE, null)
    if (stored != null) {
      return normalizeLiveUpdatePreference(stored)
    }
    val migrated = migrateLegacyLiveUpdatePreference(
      prefs.getString(LEGACY_KEY_DELIVERY_PREFERENCE, null)
    )
    if (migrated != null) {
      prefs.edit().putString(KEY_DELIVERY_PREFERENCE, migrated).apply()
      return migrated
    }
    return LIVE_UPDATE_PREFERENCE_LIVE
  }

  private fun completionAlertMode(): String =
    normalizeAlertMode(
      reactContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        .getString(KEY_COMPLETION_ALERT_MODE, null),
      DEFAULT_COMPLETION_ALERT_MODE
    )

  private fun interventionAlertMode(): String =
    normalizeAlertMode(
      reactContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        .getString(KEY_INTERVENTION_ALERT_MODE, null),
      DEFAULT_INTERVENTION_ALERT_MODE
    )

  private fun etaMode(): String =
    normalizeEtaMode(
      reactContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        .getString(KEY_ETA_MODE, null)
    )

  private fun multiAgentMode(): String =
    normalizeMultiAgentMode(
      reactContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        .getString(KEY_MULTI_AGENT_MODE, null)
    )

  private fun notificationsEnabled(): Boolean {
    val manager = reactContext.getSystemService(NotificationManager::class.java)
    return if (Build.VERSION.SDK_INT >= 24) {
      manager.areNotificationsEnabled()
    } else {
      true
    }
  }

  companion object {
    private const val PREFERENCES = "cesium-live-update-preferences"
    private const val KEY_DELIVERY_PREFERENCE = "delivery-preference-v2"
    private const val LEGACY_KEY_DELIVERY_PREFERENCE = "delivery-preference"
    private const val KEY_COMPLETION_ALERT_MODE = "alert-mode-completion"
    private const val KEY_INTERVENTION_ALERT_MODE = "alert-mode-intervention"
    private const val KEY_ETA_MODE = "display-eta-mode"
    private const val KEY_MULTI_AGENT_MODE = "display-multi-agent"
  }
}

private fun ReadableMap.toBundle(): Bundle {
  val bundle = Bundle()
  keySetIterator().let { iterator ->
    while (iterator.hasNextKey()) {
      val key = iterator.nextKey()
      when (getType(key).name) {
        "String" -> bundle.putString(key, getString(key))
        "Number" -> bundle.putDouble(key, getDouble(key))
        "Boolean" -> bundle.putBoolean(key, getBoolean(key))
        else -> Unit
      }
    }
  }
  if (hasKey("startedAt") && !isNull("startedAt")) {
    bundle.putLong("startedAt", getDouble("startedAt").toLong())
  }
  if (hasKey("estimatedCompletionAt") && !isNull("estimatedCompletionAt")) {
    bundle.putLong("estimatedCompletionAt", getDouble("estimatedCompletionAt").toLong())
  }
  listOf(
    "progress",
    "progressMax",
    "todoCompleted",
    "todoTotal",
    "todoCurrentIndex",
    "goalProgressPercent",
    "estimatedRemainingSeconds"
  ).forEach { key ->
    if (hasKey(key) && !isNull(key)) {
      bundle.putInt(key, getDouble(key).toInt())
    }
  }
  return bundle
}

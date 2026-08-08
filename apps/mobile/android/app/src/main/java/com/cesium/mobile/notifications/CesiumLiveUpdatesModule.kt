package com.cesium.mobile.notifications

import android.app.NotificationManager
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
    extras.putBoolean("promote", preference == LIVE_UPDATE_PREFERENCE_LIVE)
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
    if (!extras.getBoolean("ongoing", true)) {
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
    putInt("sdkInt", Build.VERSION.SDK_INT)
    putBoolean("progressStyleSupported", Build.VERSION.SDK_INT >= 36)
    putBoolean("canPostPromotedNotifications", CesiumAgentNotification.canPostPromoted(reactContext))
    putBoolean("notificationPermissionGranted", notificationsEnabled())
    putBoolean("suppressedByDismissal", suppressedByDismissal)
    putString("deliveryPreference", deliveryPreference())
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

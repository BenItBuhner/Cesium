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

internal const val LIVE_UPDATE_PREFERENCE_NOW_BAR = "nowbar"
internal const val LIVE_UPDATE_PREFERENCE_LIVE = "live"
internal const val LIVE_UPDATE_PREFERENCE_OFF = "off"

internal fun normalizeLiveUpdatePreference(preference: String?): String =
  when (preference) {
    LIVE_UPDATE_PREFERENCE_NOW_BAR,
    LIVE_UPDATE_PREFERENCE_LIVE,
    LIVE_UPDATE_PREFERENCE_OFF -> preference
    else -> LIVE_UPDATE_PREFERENCE_NOW_BAR
  }

class CesiumLiveUpdatesModule(
  private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "CesiumLiveUpdates"

  @ReactMethod
  fun startOrUpdate(payload: ReadableMap, promise: Promise) {
    val extras = payload.toBundle()
    when (deliveryPreference()) {
      LIVE_UPDATE_PREFERENCE_OFF -> {
        stopLiveUpdate()
        promise.resolve(statusMap())
        return
      }
      LIVE_UPDATE_PREFERENCE_LIVE -> extras.putBoolean("promote", false)
      LIVE_UPDATE_PREFERENCE_NOW_BAR -> extras.putBoolean("promote", true)
    }
    if (CesiumLiveUpdateStateStore.wasDismissed(reactContext, extras.getString("runKey"))) {
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
      reactContext.startForegroundService(intent)
    } else {
      try {
        reactContext.startService(intent)
      } catch (_: IllegalStateException) {
        CesiumLiveUpdateStateStore.clearActive(reactContext)
        val manager = reactContext.getSystemService(NotificationManager::class.java)
        manager.notify(
          CesiumAgentNotification.NOTIFICATION_ID,
          CesiumAgentNotification.build(reactContext, extras)
        )
      }
    }
    promise.resolve(statusMap())
  }

  @ReactMethod
  fun stop(promise: Promise) {
    stopLiveUpdate()
    promise.resolve(null)
  }

  private fun stopLiveUpdate() {
    val intent = Intent(reactContext, CesiumForegroundService::class.java).apply {
      action = CesiumForegroundService.ACTION_STOP
    }
    CesiumLiveUpdateStateStore.clearActive(reactContext)
    reactContext.stopService(intent)
    reactContext.getSystemService(NotificationManager::class.java)
      .cancel(CesiumAgentNotification.NOTIFICATION_ID)
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
      stopLiveUpdate()
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

  private fun deliveryPreference(): String =
    reactContext
      .getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
      .getString(KEY_DELIVERY_PREFERENCE, LIVE_UPDATE_PREFERENCE_NOW_BAR)
      .let(::normalizeLiveUpdatePreference)

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
    private const val KEY_DELIVERY_PREFERENCE = "delivery-preference"
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

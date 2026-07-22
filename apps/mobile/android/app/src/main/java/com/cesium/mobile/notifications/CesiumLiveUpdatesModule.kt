package com.cesium.mobile.notifications

import android.app.NotificationManager
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

class CesiumLiveUpdatesModule(
  private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "CesiumLiveUpdates"

  @ReactMethod
  fun startOrUpdate(payload: ReadableMap, promise: Promise) {
    val extras = payload.toBundle()
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
    val intent = Intent(reactContext, CesiumForegroundService::class.java).apply {
      action = CesiumForegroundService.ACTION_STOP
    }
    CesiumLiveUpdateStateStore.clearActive(reactContext)
    reactContext.stopService(intent)
    reactContext.getSystemService(NotificationManager::class.java)
      .cancel(CesiumAgentNotification.NOTIFICATION_ID)
    promise.resolve(null)
  }

  @ReactMethod
  fun getPromotionStatus(promise: Promise) {
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
  }

  private fun notificationsEnabled(): Boolean {
    val manager = reactContext.getSystemService(NotificationManager::class.java)
    return if (Build.VERSION.SDK_INT >= 24) {
      manager.areNotificationsEnabled()
    } else {
      true
    }
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

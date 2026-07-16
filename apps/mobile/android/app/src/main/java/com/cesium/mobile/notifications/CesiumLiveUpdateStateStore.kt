package com.cesium.mobile.notifications

import android.content.Context
import android.os.Bundle

object CesiumLiveUpdateStateStore {
  private const val STATE_PREFS = "cesium-live-update-state"
  private const val MOBILE_PREFS = "cesium-mobile"
  private const val LAST_DISMISSED_RUN_KEY = "lastDismissedRunKey"

  private val stringKeys = listOf(
    "runKey",
    "title",
    "body",
    "shortText",
    "workspaceId",
    "conversationId",
    "progressKind",
    "progressLabel",
    "intervention"
  )
  private val longKeys = listOf("startedAt", "estimatedCompletionAt")
  private val intKeys = listOf(
    "progress",
    "progressMax",
    "todoCompleted",
    "todoTotal",
    "todoCurrentIndex",
    "burnProgressPercent",
    "estimatedRemainingSeconds"
  )
  private val booleanKeys = listOf(
    "indeterminate",
    "ongoing",
    "cancellable",
    "promote"
  )

  fun saveActive(context: Context, extras: Bundle) {
    if (!extras.getBoolean("ongoing", false)) {
      clearActive(context)
      return
    }
    val edit = context.getSharedPreferences(STATE_PREFS, Context.MODE_PRIVATE).edit().clear()
    stringKeys.forEach { key ->
      if (extras.containsKey(key)) edit.putString(key, extras.getString(key))
    }
    longKeys.forEach { key ->
      if (extras.containsKey(key)) edit.putLong(key, extras.getLong(key))
    }
    intKeys.forEach { key ->
      if (extras.containsKey(key)) edit.putInt(key, extras.getInt(key))
    }
    booleanKeys.forEach { key ->
      if (extras.containsKey(key)) edit.putBoolean(key, extras.getBoolean(key))
    }
    edit.putBoolean("hasActiveState", true).apply()
  }

  fun loadActive(context: Context): Bundle? {
    val prefs = context.getSharedPreferences(STATE_PREFS, Context.MODE_PRIVATE)
    if (!prefs.getBoolean("hasActiveState", false)) {
      return null
    }
    return Bundle().apply {
      stringKeys.forEach { key ->
        if (prefs.contains(key)) putString(key, prefs.getString(key, null))
      }
      longKeys.forEach { key ->
        if (prefs.contains(key)) putLong(key, prefs.getLong(key, 0L))
      }
      intKeys.forEach { key ->
        if (prefs.contains(key)) putInt(key, prefs.getInt(key, 0))
      }
      booleanKeys.forEach { key ->
        if (prefs.contains(key)) putBoolean(key, prefs.getBoolean(key, false))
      }
    }
  }

  fun clearActive(context: Context) {
    context.getSharedPreferences(STATE_PREFS, Context.MODE_PRIVATE).edit().clear().apply()
  }

  fun markDismissed(context: Context, runKey: String?) {
    context.getSharedPreferences(MOBILE_PREFS, Context.MODE_PRIVATE)
      .edit()
      .putString(LAST_DISMISSED_RUN_KEY, runKey)
      .putLong("lastDismissedAt", System.currentTimeMillis())
      .apply()
  }

  fun wasDismissed(context: Context, runKey: String?): Boolean {
    if (runKey.isNullOrBlank()) return false
    return context.getSharedPreferences(MOBILE_PREFS, Context.MODE_PRIVATE)
      .getString(LAST_DISMISSED_RUN_KEY, null) == runKey
  }
}

package com.cesium.mobile.notifications

import android.content.Context
import android.os.Bundle
import org.json.JSONArray
import org.json.JSONObject

/**
 * Persists every active agent run (keyed by runKey) so the foreground service
 * can restore all live notifications after a process restart, plus the set of
 * runs the user explicitly dismissed so they are not resurrected.
 */
object CesiumLiveUpdateStateStore {
  private const val STATE_PREFS = "cesium-live-update-state"
  private const val MOBILE_PREFS = "cesium-mobile"
  private const val RUNS_KEY = "activeRunsJson"
  private const val DISMISSED_RUNS_KEY = "dismissedRunKeysJson"
  private const val LEGACY_HAS_ACTIVE_STATE = "hasActiveState"
  private const val LEGACY_LAST_DISMISSED_RUN_KEY = "lastDismissedRunKey"
  private const val MAX_DISMISSED_RUNS = 16

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
    "goalProgressPercent",
    "estimatedRemainingSeconds"
  )
  private val booleanKeys = listOf(
    "indeterminate",
    "ongoing",
    "cancellable",
    "promote"
  )

  fun saveRun(context: Context, extras: Bundle) {
    val runKey = extras.getString("runKey")
    if (runKey.isNullOrBlank()) return
    if (!extras.getBoolean("ongoing", false)) {
      removeRun(context, runKey)
      return
    }
    val runs = readRuns(context)
    runs.put(runKey, bundleToJson(extras))
    writeRuns(context, runs)
  }

  fun removeRun(context: Context, runKey: String?) {
    if (runKey.isNullOrBlank()) return
    val runs = readRuns(context)
    if (!runs.has(runKey)) return
    runs.remove(runKey)
    writeRuns(context, runs)
  }

  fun loadRuns(context: Context): List<Bundle> {
    val runs = readRuns(context)
    val result = mutableListOf<Bundle>()
    runs.keys().forEach { key ->
      val json = runs.optJSONObject(key) ?: return@forEach
      result.add(jsonToBundle(json))
    }
    // Oldest run first so the restored foreground anchor is stable.
    result.sortBy { it.getLong("startedAt", Long.MAX_VALUE) }
    return result
  }

  fun activeRunKeys(context: Context): List<String> =
    loadRuns(context).mapNotNull { it.getString("runKey") }

  fun clearActive(context: Context) {
    context.getSharedPreferences(STATE_PREFS, Context.MODE_PRIVATE)
      .edit()
      .remove(RUNS_KEY)
      .remove(LEGACY_HAS_ACTIVE_STATE)
      .apply()
  }

  fun markDismissed(context: Context, runKey: String?) {
    if (runKey.isNullOrBlank()) return
    val dismissed = readDismissed(context).toMutableList()
    dismissed.remove(runKey)
    dismissed.add(runKey)
    while (dismissed.size > MAX_DISMISSED_RUNS) {
      dismissed.removeAt(0)
    }
    context.getSharedPreferences(MOBILE_PREFS, Context.MODE_PRIVATE)
      .edit()
      .putString(DISMISSED_RUNS_KEY, JSONArray(dismissed).toString())
      .putLong("lastDismissedAt", System.currentTimeMillis())
      .apply()
  }

  fun wasDismissed(context: Context, runKey: String?): Boolean {
    if (runKey.isNullOrBlank()) return false
    if (readDismissed(context).contains(runKey)) return true
    // Migration: honor the single-slot key written by older builds.
    return context.getSharedPreferences(MOBILE_PREFS, Context.MODE_PRIVATE)
      .getString(LEGACY_LAST_DISMISSED_RUN_KEY, null) == runKey
  }

  private fun readDismissed(context: Context): List<String> {
    val raw = context.getSharedPreferences(MOBILE_PREFS, Context.MODE_PRIVATE)
      .getString(DISMISSED_RUNS_KEY, null) ?: return emptyList()
    return try {
      val array = JSONArray(raw)
      (0 until array.length()).mapNotNull { index -> array.optString(index, null) }
    } catch (_: Exception) {
      emptyList()
    }
  }

  private fun readRuns(context: Context): JSONObject {
    val raw = context.getSharedPreferences(STATE_PREFS, Context.MODE_PRIVATE)
      .getString(RUNS_KEY, null) ?: return JSONObject()
    return try {
      JSONObject(raw)
    } catch (_: Exception) {
      JSONObject()
    }
  }

  private fun writeRuns(context: Context, runs: JSONObject) {
    context.getSharedPreferences(STATE_PREFS, Context.MODE_PRIVATE)
      .edit()
      .putString(RUNS_KEY, runs.toString())
      .apply()
  }

  private fun bundleToJson(extras: Bundle): JSONObject {
    val json = JSONObject()
    stringKeys.forEach { key ->
      if (extras.containsKey(key)) json.put(key, extras.getString(key))
    }
    longKeys.forEach { key ->
      if (extras.containsKey(key)) json.put(key, extras.getLong(key))
    }
    intKeys.forEach { key ->
      if (extras.containsKey(key)) json.put(key, extras.getInt(key))
    }
    booleanKeys.forEach { key ->
      if (extras.containsKey(key)) json.put(key, extras.getBoolean(key))
    }
    return json
  }

  private fun jsonToBundle(json: JSONObject): Bundle {
    val bundle = Bundle()
    stringKeys.forEach { key ->
      if (json.has(key) && !json.isNull(key)) bundle.putString(key, json.optString(key))
    }
    longKeys.forEach { key ->
      if (json.has(key)) bundle.putLong(key, json.optLong(key))
    }
    intKeys.forEach { key ->
      if (json.has(key)) bundle.putInt(key, json.optInt(key))
    }
    booleanKeys.forEach { key ->
      if (json.has(key)) bundle.putBoolean(key, json.optBoolean(key))
    }
    return bundle
  }
}

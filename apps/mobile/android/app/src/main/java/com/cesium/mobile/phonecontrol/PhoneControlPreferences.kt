package com.cesium.mobile.phonecontrol

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.util.UUID

data class PhoneControlConnectionConfig(
  val enabled: Boolean,
  val serverUrl: String,
  val workspaceId: String,
  val authToken: String?,
  val deviceToken: String?,
  val backendId: String,
  val mode: String,
  val modelId: String?,
  val modelName: String?
) {
  val configured: Boolean
    get() = enabled && serverUrl.isNotBlank() && workspaceId.isNotBlank()
}

object PhoneControlPreferences {
  private const val PREFS = "cesium_phone_control"
  private const val KEY_DEVICE_ID = "device_id"
  private const val KEY_ENABLED = "enabled"
  private const val KEY_SERVER_URL = "server_url"
  private const val KEY_WORKSPACE_ID = "workspace_id"
  private const val KEY_AUTH_TOKEN = "auth_token"
  private const val KEY_DEVICE_TOKEN = "device_token"
  private const val KEY_BACKEND_ID = "backend_id"
  private const val KEY_MODE = "mode"
  private const val KEY_MODEL_ID = "model_id"
  private const val KEY_MODEL_NAME = "model_name"
  private const val CONFIG_FILE = "phone-control-connection.json"

  fun deviceId(context: Context): String {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val existing = prefs.getString(KEY_DEVICE_ID, null)
    if (!existing.isNullOrBlank()) {
      return existing
    }
    val next = "android-${UUID.randomUUID()}"
    prefs.edit().putString(KEY_DEVICE_ID, next).apply()
    return next
  }

  fun read(context: Context): PhoneControlConnectionConfig {
    readSnapshot(context)?.let { return it }
    return readPreferences(context)
  }

  private fun readPreferences(context: Context): PhoneControlConnectionConfig {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    return PhoneControlConnectionConfig(
      enabled = prefs.getBoolean(KEY_ENABLED, false),
      serverUrl = prefs.getString(KEY_SERVER_URL, "")?.trimEnd('/') ?: "",
      workspaceId = prefs.getString(KEY_WORKSPACE_ID, "") ?: "",
      authToken = prefs.getString(KEY_AUTH_TOKEN, null)?.takeIf { it.isNotBlank() },
      deviceToken = prefs.getString(KEY_DEVICE_TOKEN, null)?.takeIf { it.isNotBlank() },
      backendId = prefs.getString(KEY_BACKEND_ID, "cesium-agent") ?: "cesium-agent",
      mode = prefs.getString(KEY_MODE, "agent") ?: "agent",
      modelId = prefs.getString(KEY_MODEL_ID, null)?.takeIf { it.isNotBlank() },
      modelName = prefs.getString(KEY_MODEL_NAME, null)?.takeIf { it.isNotBlank() }
    )
  }

  fun update(context: Context, json: String): PhoneControlConnectionConfig {
    val input = JSONObject(json)
    val editor = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
    if (input.has("enabled")) editor.putBoolean(KEY_ENABLED, input.optBoolean("enabled", false))
    putOptionalString(editor, KEY_SERVER_URL, input, "serverUrl", trimTrailingSlash = true)
    putOptionalString(editor, KEY_WORKSPACE_ID, input, "workspaceId")
    putOptionalString(editor, KEY_AUTH_TOKEN, input, "authToken")
    putOptionalString(editor, KEY_BACKEND_ID, input, "backendId")
    putOptionalString(editor, KEY_MODE, input, "mode")
    putOptionalString(editor, KEY_MODEL_ID, input, "modelId")
    putOptionalString(editor, KEY_MODEL_NAME, input, "modelName")
    editor.commit()
    return readPreferences(context).also { writeSnapshot(context, it) }
  }

  fun setEnabled(context: Context, enabled: Boolean): PhoneControlConnectionConfig {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .putBoolean(KEY_ENABLED, enabled)
      .commit()
    return readPreferences(context).also { writeSnapshot(context, it) }
  }

  fun setDeviceToken(context: Context, deviceToken: String): PhoneControlConnectionConfig {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_DEVICE_TOKEN, deviceToken)
      .commit()
    return readPreferences(context).also { writeSnapshot(context, it) }
  }

  private fun readSnapshot(context: Context): PhoneControlConnectionConfig? {
    val file = File(context.filesDir, CONFIG_FILE)
    if (!file.isFile) return null
    return runCatching {
      val json = JSONObject(file.readText())
      PhoneControlConnectionConfig(
        enabled = json.optBoolean("enabled", false),
        serverUrl = json.optString("serverUrl").trimEnd('/'),
        workspaceId = json.optString("workspaceId"),
        authToken = json.optString("authToken").takeIf { it.isNotBlank() },
        deviceToken = json.optString("deviceToken").takeIf { it.isNotBlank() },
        backendId = json.optString("backendId", "cesium-agent"),
        mode = json.optString("mode", "agent"),
        modelId = json.optString("modelId").takeIf { it.isNotBlank() },
        modelName = json.optString("modelName").takeIf { it.isNotBlank() }
      )
    }.getOrNull()
  }

  private fun writeSnapshot(context: Context, config: PhoneControlConnectionConfig) {
    val target = File(context.filesDir, CONFIG_FILE)
    val temporary = File(context.filesDir, "$CONFIG_FILE.tmp")
    val json = JSONObject().apply {
      put("enabled", config.enabled)
      put("serverUrl", config.serverUrl)
      put("workspaceId", config.workspaceId)
      put("authToken", config.authToken ?: JSONObject.NULL)
      put("deviceToken", config.deviceToken ?: JSONObject.NULL)
      put("backendId", config.backendId)
      put("mode", config.mode)
      put("modelId", config.modelId ?: JSONObject.NULL)
      put("modelName", config.modelName ?: JSONObject.NULL)
    }
    temporary.writeText(json.toString())
    if (!temporary.renameTo(target)) {
      target.writeText(json.toString())
      temporary.delete()
    }
  }

  private fun putOptionalString(
    editor: android.content.SharedPreferences.Editor,
    storageKey: String,
    input: JSONObject,
    jsonKey: String,
    trimTrailingSlash: Boolean = false
  ) {
    if (!input.has(jsonKey)) return
    if (input.isNull(jsonKey)) {
      editor.remove(storageKey)
      return
    }
    var value = input.optString(jsonKey, "").trim()
    if (trimTrailingSlash) value = value.trimEnd('/')
    if (value.isBlank()) editor.remove(storageKey) else editor.putString(storageKey, value)
  }
}

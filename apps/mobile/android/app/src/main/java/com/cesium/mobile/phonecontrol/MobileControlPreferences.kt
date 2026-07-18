package com.cesium.mobile.phonecontrol

import android.content.Context
import android.provider.Settings

data class MobileControlConnectionConfig(
  val enabled: Boolean,
  val serverUrl: String,
  val workspaceId: String,
  val authToken: String?
)

object MobileControlPreferences {
  private const val PREFS = "cesium_mobile_control"
  private const val KEY_ENABLED = "enabled"
  private const val KEY_SERVER_URL = "server_url"
  private const val KEY_WORKSPACE_ID = "workspace_id"
  private const val KEY_AUTH_TOKEN = "auth_token"

  fun read(context: Context): MobileControlConnectionConfig {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    return MobileControlConnectionConfig(
      enabled = prefs.getBoolean(KEY_ENABLED, false),
      serverUrl = prefs.getString(KEY_SERVER_URL, "")?.trim().orEmpty(),
      workspaceId = prefs.getString(KEY_WORKSPACE_ID, "")?.trim().orEmpty(),
      authToken = prefs.getString(KEY_AUTH_TOKEN, null)?.takeIf { it.isNotBlank() }
    )
  }

  fun updateConnection(
    context: Context,
    serverUrl: String,
    workspaceId: String,
    authToken: String?
  ): MobileControlConnectionConfig {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_SERVER_URL, serverUrl.trim())
      .putString(KEY_WORKSPACE_ID, workspaceId.trim())
      .apply {
        if (authToken.isNullOrBlank()) remove(KEY_AUTH_TOKEN)
        else putString(KEY_AUTH_TOKEN, authToken)
      }
      .apply()
    return read(context)
  }

  fun setEnabled(context: Context, enabled: Boolean): MobileControlConnectionConfig {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .putBoolean(KEY_ENABLED, enabled)
      .apply()
    return read(context)
  }

  fun stableDeviceId(context: Context): String {
    val raw =
      Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
        ?.takeIf { it.isNotBlank() }
        ?: "unknown"
    return "android-${raw.take(24)}"
  }
}

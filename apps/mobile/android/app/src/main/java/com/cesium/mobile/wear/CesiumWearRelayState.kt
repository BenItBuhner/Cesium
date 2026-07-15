package com.cesium.mobile.wear

import android.content.Context

object CesiumWearRelayState {
  private const val PREFS = "cesium-wear-relay"
  private const val SERVER_BASE_URL = "serverBaseUrl"
  private const val SERVER_LABEL = "serverLabel"
  private const val AUTH_TOKEN = "authToken"
  private const val WORKSPACE_ID = "workspaceId"
  private const val CONVERSATION_ID = "conversationId"

  fun save(context: Context, config: RelayConfig) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .putString(SERVER_BASE_URL, config.serverBaseUrl)
      .putString(SERVER_LABEL, config.serverLabel)
      .putString(AUTH_TOKEN, config.authToken)
      .putString(WORKSPACE_ID, config.workspaceId)
      .putString(CONVERSATION_ID, config.conversationId)
      .apply()
  }

  fun read(context: Context): RelayConfig? {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val baseUrl = prefs.getString(SERVER_BASE_URL, null)?.trim().orEmpty()
    val workspaceId = prefs.getString(WORKSPACE_ID, null)?.trim().orEmpty()
    if (baseUrl.isEmpty() || workspaceId.isEmpty()) {
      return null
    }
    return RelayConfig(
      serverBaseUrl = baseUrl,
      serverLabel = prefs.getString(SERVER_LABEL, null) ?: "This device",
      authToken = prefs.getString(AUTH_TOKEN, null),
      workspaceId = workspaceId,
      conversationId = prefs.getString(CONVERSATION_ID, null)
    )
  }
}

data class RelayConfig(
  val serverBaseUrl: String,
  val serverLabel: String,
  val authToken: String?,
  val workspaceId: String,
  val conversationId: String?
)

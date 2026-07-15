package com.cesium.mobile.wear

import android.content.Context
import android.content.Intent
import com.cesium.mobile.MainActivity
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

class CesiumWearActionRouter(
  private val context: Context,
  private val client: OkHttpClient = OkHttpClient()
) {
  fun route(path: String, payload: ByteArray) {
    val json = runCatching { JSONObject(String(payload, Charsets.UTF_8)) }.getOrNull() ?: JSONObject()
    if (path == CesiumWearPaths.ACTION_OPEN_ON_PHONE || json.optString("action") == "open_on_phone") {
      openOnPhone(json)
      return
    }
    val config = CesiumWearRelayState.read(context) ?: return
    val conversationId = json.optString("conversationId", config.conversationId.orEmpty())
    if (conversationId.isBlank()) return
    val route = when (path) {
      CesiumWearPaths.ACTION_CANCEL -> "/api/agents/conversations/${encode(conversationId)}/cancel"
      CesiumWearPaths.ACTION_PAUSE -> "/api/agents/conversations/${encode(conversationId)}/pause"
      CesiumWearPaths.ACTION_RESUME -> "/api/agents/conversations/${encode(conversationId)}/resume"
      CesiumWearPaths.ACTION_ANSWER_QUESTION -> "/api/agents/conversations/${encode(conversationId)}/question"
      CesiumWearPaths.ACTION_ANSWER_PERMISSION -> "/api/agents/conversations/${encode(conversationId)}/permission"
      CesiumWearPaths.ACTION_PROMPT -> "/api/agents/conversations/${encode(conversationId)}/prompt"
      else -> return
    }
    post(config, route, requestBody(path, json))
  }

  private fun openOnPhone(json: JSONObject) {
    val intent = Intent(context, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      putExtra("cesiumAction", "open")
      putExtra("conversationId", json.optString("conversationId", null))
      putExtra("workspaceId", json.optString("workspaceId", null))
    }
    context.startActivity(intent)
  }

  private fun post(config: RelayConfig, path: String, body: String) {
    val request = Request.Builder()
      .url("${config.serverBaseUrl.trimEnd('/')}$path")
      .header("content-type", "application/json")
      .header("x-opencursor-workspace-id", config.workspaceId)
      .apply {
        config.authToken?.takeIf { it.isNotBlank() }?.let {
          header("x-opencursor-session-token", it)
        }
      }
      .post(body.toRequestBody("application/json".toMediaType()))
      .build()
    runCatching { client.newCall(request).execute().close() }
  }

  private fun requestBody(path: String, json: JSONObject): String =
    when (path) {
      CesiumWearPaths.ACTION_ANSWER_QUESTION -> JSONObject()
        .put("questionId", json.optString("questionId"))
        .put("answer", json.optString("answer"))
        .toString()
      CesiumWearPaths.ACTION_ANSWER_PERMISSION -> JSONObject()
        .put("requestId", json.optString("requestId"))
        .apply {
          if (json.has("optionId")) put("optionId", json.optString("optionId"))
          if (json.has("cancelled")) put("cancelled", json.optBoolean("cancelled"))
        }
        .toString()
      CesiumWearPaths.ACTION_PROMPT -> JSONObject()
        .put("text", json.optString("text"))
        .toString()
      else -> "{}"
    }

  private fun encode(value: String): String =
    URLEncoder.encode(value, StandardCharsets.UTF_8.name())
}

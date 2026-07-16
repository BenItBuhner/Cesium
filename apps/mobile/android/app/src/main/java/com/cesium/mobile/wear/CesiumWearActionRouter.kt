package com.cesium.mobile.wear

import android.content.Context
import android.content.Intent
import com.cesium.mobile.MainActivity
import com.cesium.shared.generated.CesiumDataLayerPaths
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
    val action = CesiumDataLayerPaths.actionForPath(path) ?: json.optString("action")
    if (action == "open_on_phone" || action == "open") {
      openOnPhone(json)
      return
    }
    val config = CesiumWearRelayState.read(context) ?: return
    val conversationId = json.optString("conversationId", config.conversationId.orEmpty())
    if (conversationId.isBlank()) return
    val route = when (action) {
      "cancel" -> "/api/agents/conversations/${encode(conversationId)}/cancel"
      "pause" -> "/api/agents/conversations/${encode(conversationId)}/pause"
      "resume" -> "/api/agents/conversations/${encode(conversationId)}/resume"
      "answer_question" -> "/api/agents/conversations/${encode(conversationId)}/question"
      "answer_permission" -> "/api/agents/conversations/${encode(conversationId)}/permission"
      "prompt" -> "/api/agents/conversations/${encode(conversationId)}/prompt"
      else -> return
    }
    post(config, route, requestBody(action, json))
  }

  private fun openOnPhone(json: JSONObject) {
    val intent = Intent(context, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      putExtra("cesiumAction", "open")
      putExtra("conversationId", json.optString("conversationId").takeIf { it.isNotBlank() })
      putExtra("workspaceId", json.optString("workspaceId").takeIf { it.isNotBlank() })
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

  private fun requestBody(action: String, json: JSONObject): String =
    when (action) {
      "answer_question" -> JSONObject()
        .put("questionId", json.optString("questionId"))
        .put("answer", json.optString("answer"))
        .toString()
      "answer_permission" -> JSONObject()
        .put("requestId", json.optString("requestId"))
        .apply {
          if (json.has("optionId")) put("optionId", json.optString("optionId"))
          if (json.has("cancelled")) put("cancelled", json.optBoolean("cancelled"))
        }
        .toString()
      "prompt" -> JSONObject()
        .put("text", json.optString("text"))
        .toString()
      else -> "{}"
    }

  private fun encode(value: String): String =
    URLEncoder.encode(value, StandardCharsets.UTF_8.name())
}

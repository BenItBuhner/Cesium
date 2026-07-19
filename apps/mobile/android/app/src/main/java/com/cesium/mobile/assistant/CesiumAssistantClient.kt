package com.cesium.mobile.assistant

import android.content.Context
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import com.cesium.mobile.phonecontrol.PhoneControlConnectionConfig
import com.cesium.mobile.phonecontrol.PhoneControlPreferences
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.concurrent.TimeUnit

class CesiumAssistantClient(private val context: Context) {
  private val handler = Handler(Looper.getMainLooper())
  private val client = OkHttpClient.Builder()
    .connectTimeout(10, TimeUnit.SECONDS)
    .readTimeout(30, TimeUnit.SECONDS)
    .build()

  fun createAgent(
    requestText: String,
    screenContext: String,
    screenshot: Bitmap?,
    update: (status: String, answer: String?) -> Unit
  ) {
    val config = PhoneControlPreferences.read(context)
    if (config.serverUrl.isBlank() || config.workspaceId.isBlank()) {
      update("Open Cesium once and select a server and workspace first.", null)
      return
    }
    val text = buildString {
      append(requestText.trim())
      if (screenContext.isNotBlank()) {
        append("\n\nCurrent Android screen context supplied by the system assistant:\n")
        append(screenContext.take(12_000))
      }
    }
    update("Starting agent…", null)
    resolveModel(config) { modelId ->
      startAgent(config, text, screenshot, modelId, update)
    }
  }

  private fun startAgent(
    config: PhoneControlConnectionConfig,
    text: String,
    screenshot: Bitmap?,
    modelId: String?,
    update: (status: String, answer: String?) -> Unit
  ) {
    val body = JSONObject().apply {
      put("conversation", JSONObject().apply {
        put("backendId", config.backendId)
        put("mode", config.mode)
        modelId?.let {
          put("modelId", it)
          put("modelName", config.modelName ?: it)
        }
      })
      put("text", text)
      if (screenshot != null) {
        put("attachments", JSONArray().put(JSONObject().apply {
          put("mimeType", "image/jpeg")
          put("name", "assistant-screen.jpg")
          put("data", encodeScreenshot(screenshot))
        }))
      }
    }
    client.newCall(
      request(
        config.serverUrl,
        config.workspaceId,
        config.authToken,
        "/api/agents/conversations/create-and-prompt",
        "POST",
        body
      )
    ).enqueue(object : Callback {
      override fun onFailure(call: Call, error: IOException) {
        handler.post { update("Could not reach the Cesium server: ${error.message}", null) }
      }

      override fun onResponse(call: Call, response: Response) {
        response.use {
          val raw = it.body?.string() ?: "{}"
          if (!it.isSuccessful) {
            val message = runCatching { JSONObject(raw).optString("error") }.getOrNull()
            handler.post { update(message?.takeIf(String::isNotBlank) ?: "Server returned HTTP ${it.code}.", null) }
            return
          }
          val conversationId = runCatching {
            JSONObject(raw).getJSONObject("snapshot").getJSONObject("conversation").getString("id")
          }.getOrNull()
          if (conversationId == null) {
            handler.post { update("Agent started, but the server response had no conversation id.", null) }
            return
          }
          handler.post { update("Agent is working. You can dismiss this overlay.", null) }
          poll(config.serverUrl, config.workspaceId, config.authToken, conversationId, update)
        }
      }
    })
  }

  private fun resolveModel(
    config: PhoneControlConnectionConfig,
    completed: (String?) -> Unit
  ) {
    if (config.modelId != null) {
      completed(config.modelId)
      return
    }
    client.newCall(
      request(
        config.serverUrl,
        config.workspaceId,
        config.authToken,
        "/api/settings/cesium-agent",
        "GET",
        null
      )
    ).enqueue(object : Callback {
      override fun onFailure(call: Call, error: IOException) {
        completed(null)
      }

      override fun onResponse(call: Call, response: Response) {
        response.use {
          val modelId = if (it.isSuccessful) {
            runCatching {
              JSONObject(it.body?.string() ?: "{}")
                .getJSONObject("settings")
                .optString("defaultModelId")
                .takeIf(String::isNotBlank)
            }.getOrNull()
          } else {
            null
          }
          completed(modelId)
        }
      }
    })
  }

  private fun poll(
    serverUrl: String,
    workspaceId: String,
    authToken: String?,
    conversationId: String,
    update: (status: String, answer: String?) -> Unit
  ) {
    val encodedId = java.net.URLEncoder.encode(conversationId, Charsets.UTF_8.name())
    client.newCall(
      request(
        serverUrl,
        workspaceId,
        authToken,
        "/api/agents/conversations/$encodedId?full=1",
        "GET",
        null
      )
    ).enqueue(object : Callback {
      override fun onFailure(call: Call, error: IOException) {
        handler.postDelayed(
          { poll(serverUrl, workspaceId, authToken, conversationId, update) },
          2_500
        )
      }

      override fun onResponse(call: Call, response: Response) {
        response.use {
          if (!it.isSuccessful) {
            handler.postDelayed(
              { poll(serverUrl, workspaceId, authToken, conversationId, update) },
              2_500
            )
            return
          }
          val snapshot = runCatching {
            JSONObject(it.body?.string() ?: "{}").getJSONObject("snapshot")
          }.getOrNull()
          if (snapshot == null) {
            handler.postDelayed(
              { poll(serverUrl, workspaceId, authToken, conversationId, update) },
              2_500
            )
            return
          }
          val conversation = snapshot.optJSONObject("conversation") ?: JSONObject()
          val status = conversation.optString("status", "running")
          val answer = assistantText(snapshot.optJSONArray("events") ?: JSONArray())
          handler.post {
            update(
              when (status) {
                "idle", "completed" -> "Done"
                "failed", "cancelled" -> "Agent $status"
                else -> "Agent is working. You can dismiss this overlay."
              },
              answer.takeIf { text -> text.isNotBlank() }
            )
          }
          if (status !in setOf("idle", "completed", "failed", "cancelled")) {
            handler.postDelayed(
              { poll(serverUrl, workspaceId, authToken, conversationId, update) },
              1_500
            )
          }
        }
      }
    })
  }

  private fun assistantText(events: JSONArray): String {
    val chunks = StringBuilder()
    for (index in 0 until events.length()) {
      val event = events.optJSONObject(index) ?: continue
      if (event.optString("kind") == "assistant_message_chunk") {
        chunks.append(event.optString("text"))
      }
    }
    return chunks.toString().takeLast(8_000)
  }

  private fun request(
    serverUrl: String,
    workspaceId: String,
    authToken: String?,
    path: String,
    method: String,
    body: JSONObject?
  ): Request {
    val builder = Request.Builder()
      .url("${serverUrl.trimEnd('/')}$path")
      .header("x-opencursor-workspace-id", workspaceId)
      .header("Accept", "application/json")
    authToken?.let { builder.header("x-opencursor-session-token", it) }
    return builder.method(
      method,
      body?.toString()?.toRequestBody(JSON_MEDIA_TYPE)
    ).build()
  }

  private fun encodeScreenshot(bitmap: Bitmap): String {
    val output = ByteArrayOutputStream()
    bitmap.compress(Bitmap.CompressFormat.JPEG, 68, output)
    return android.util.Base64.encodeToString(output.toByteArray(), android.util.Base64.NO_WRAP)
  }

  companion object {
    private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
  }
}

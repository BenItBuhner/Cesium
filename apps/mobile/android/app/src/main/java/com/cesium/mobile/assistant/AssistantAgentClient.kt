package com.cesium.mobile.assistant

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.cesium.mobile.phonecontrol.MobileControlPreferences
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

class AssistantAgentClient(private val context: Context) {
  interface Listener {
    fun onStarted(conversationId: String)
    fun onUpdate(text: String, status: String)
    fun onError(message: String)
  }

  private val client = OkHttpClient.Builder()
    .connectTimeout(15, TimeUnit.SECONDS)
    .readTimeout(30, TimeUnit.SECONDS)
    .build()
  private val handler = Handler(Looper.getMainLooper())
  @Volatile private var polling = true

  fun submit(
    prompt: String,
    screenContext: String?,
    screenshotBase64: String?,
    listener: Listener
  ) {
    val config = MobileControlPreferences.read(context)
    val base = config.serverUrl.toHttpUrlOrNull()
    if (base == null || config.workspaceId.isBlank()) {
      listener.onError("Connect Cesium mobile control to a server and workspace first.")
      return
    }
    val contextualPrompt = buildString {
      append(prompt.trim())
      if (!screenContext.isNullOrBlank()) {
        append("\n\nCurrent Android context (provided by the system assistant):\n")
        append(screenContext.take(12_000))
      }
    }
    val attachments = JSONArray()
    if (!screenshotBase64.isNullOrBlank()) {
      attachments.put(
        JSONObject()
          .put("mimeType", "image/jpeg")
          .put("data", screenshotBase64)
          .put("name", "assistant-screen.jpg")
      )
    }
    val body = JSONObject()
      .put("conversation", JSONObject().put("title", prompt.take(60)))
      .put("text", contextualPrompt)
      .apply {
        if (attachments.length() > 0) put("attachments", attachments)
      }
    val request = requestBuilder(
      base.newBuilder().encodedPath("/api/agents/conversations/create-and-prompt").query(null).build().toString(),
      config.workspaceId,
      config.authToken
    )
      .post(body.toString().toRequestBody(JSON_MEDIA_TYPE))
      .build()
    client.newCall(request).enqueue(object : Callback {
      override fun onFailure(call: Call, error: IOException) {
        listener.onError(error.message ?: "Failed to start the assistant conversation.")
      }

      override fun onResponse(call: Call, response: Response) {
        response.use {
          val payload = it.body?.string().orEmpty()
          if (!it.isSuccessful) {
            listener.onError(readError(payload, "Assistant request failed (${it.code})."))
            return
          }
          val conversationId = try {
            JSONObject(payload)
              .getJSONObject("snapshot")
              .getJSONObject("conversation")
              .getString("id")
          } catch (_: Throwable) {
            listener.onError("Cesium returned an invalid conversation response.")
            return
          }
          listener.onStarted(conversationId)
          poll(base.toString(), config.workspaceId, config.authToken, conversationId, listener)
        }
      }
    })
  }

  fun stopPolling() {
    polling = false
  }

  private fun poll(
    baseUrl: String,
    workspaceId: String,
    authToken: String?,
    conversationId: String,
    listener: Listener
  ) {
    if (!polling) return
    val base = baseUrl.toHttpUrlOrNull() ?: return
    val url = base.newBuilder()
      .encodedPath("/api/agents/conversations/$conversationId")
      .query(null)
      .addQueryParameter("full", "1")
      .build()
    client.newCall(requestBuilder(url.toString(), workspaceId, authToken).get().build())
      .enqueue(object : Callback {
        override fun onFailure(call: Call, error: IOException) {
          if (polling) schedulePoll(baseUrl, workspaceId, authToken, conversationId, listener)
        }

        override fun onResponse(call: Call, response: Response) {
          response.use {
            if (!it.isSuccessful) {
              if (polling) schedulePoll(baseUrl, workspaceId, authToken, conversationId, listener)
              return
            }
            val payload = try {
              JSONObject(it.body?.string().orEmpty()).getJSONObject("snapshot")
            } catch (_: Throwable) {
              schedulePoll(baseUrl, workspaceId, authToken, conversationId, listener)
              return
            }
            val status = payload.getJSONObject("conversation").optString("status", "running")
            val text = assistantText(payload.optJSONArray("events") ?: JSONArray())
            listener.onUpdate(text, status)
            if (polling && status in ACTIVE_STATUSES) {
              schedulePoll(baseUrl, workspaceId, authToken, conversationId, listener)
            }
          }
        }
      })
  }

  private fun schedulePoll(
    baseUrl: String,
    workspaceId: String,
    authToken: String?,
    conversationId: String,
    listener: Listener
  ) {
    handler.postDelayed({
      poll(baseUrl, workspaceId, authToken, conversationId, listener)
    }, 750)
  }

  private fun requestBuilder(
    url: String,
    workspaceId: String,
    authToken: String?
  ): Request.Builder =
    Request.Builder()
      .url(url)
      .header("Content-Type", "application/json")
      .header("x-opencursor-workspace-id", workspaceId)
      .apply {
        authToken?.let { header("x-opencursor-session-token", it) }
      }

  private fun assistantText(events: JSONArray): String {
    val chunks = StringBuilder()
    for (index in 0 until events.length()) {
      val event = events.optJSONObject(index) ?: continue
      if (event.optString("kind") == "assistant_message_chunk") {
        chunks.append(event.optString("text"))
      }
    }
    return chunks.toString().trim()
  }

  private fun readError(payload: String, fallback: String): String =
    try {
      JSONObject(payload).optString("error").takeIf { it.isNotBlank() } ?: fallback
    } catch (_: Throwable) {
      fallback
    }

  companion object {
    private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    private val ACTIVE_STATUSES = setOf(
      "running",
      "pause_requested",
      "pausing",
      "awaiting_permission",
      "awaiting_question"
    )
  }
}

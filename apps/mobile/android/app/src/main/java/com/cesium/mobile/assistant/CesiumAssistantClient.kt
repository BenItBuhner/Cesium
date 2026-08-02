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
    .readTimeout(60, TimeUnit.SECONDS)
    .build()

  /**
   * Voice control plane turn — the same principle as the web orb: one fast
   * controller call that either answers directly (spoken via TTS) or
   * delegates into a full Cesium session (session_start / session_message),
   * with harness-style compaction keeping the running history bounded so
   * the assistant can be used indefinitely. Falls back to the legacy
   * create-and-prompt agent when the voice route is unavailable.
   */
  fun runVoiceTurn(
    requestText: String,
    screenContext: String,
    screenshot: Bitmap?,
    update: (status: String, answer: String?) -> Unit,
    speak: (String) -> Unit
  ) {
    val config = PhoneControlPreferences.read(context)
    if (config.serverUrl.isBlank() || config.workspaceId.isBlank()) {
      update("Open Cesium once and select a server and workspace first.", null)
      return
    }
    val utterance = buildString {
      append(requestText.trim())
      append(
        "\n\n[Context: you are the live voice assistant on the user's Android phone. " +
          "If you delegate work with session_start, tell the delegated agent it can " +
          "control this phone through the built-in \"phone\" MCP server via " +
          "call_mcp_tool — phone_screenshot, phone_snapshot, phone_apps, phone_tap, " +
          "phone_type, phone_swipe, phone_global_action, phone_settings.]"
      )
      if (screenContext.isNotBlank()) {
        append("\n\nForeground screen text:\n")
        append(screenContext.take(3_000))
      }
    }
    val body = JSONObject().apply {
      put("utterance", utterance)
      put("mode", "active")
      synchronized(memoryLock) {
        put("history", JSONArray(history.toString()))
        summary?.let { put("summary", it) }
      }
    }
    update("Thinking…", null)
    client.newCall(
      request(
        config.serverUrl,
        config.workspaceId,
        config.authToken,
        "/api/voice/controller",
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
            // Voice plane unavailable (e.g. controller not configured):
            // keep working through the legacy full-agent path.
            handler.post {
              createAgent(requestText, screenContext, screenshot, update)
            }
            return
          }
          val result = runCatching { JSONObject(raw).getJSONObject("result") }.getOrNull()
          if (result == null) {
            handler.post { update("Voice controller returned an unreadable response.", null) }
            return
          }
          val spokenText = result.optString("spokenText")
          val displayText = result.optString("displayText").ifBlank { spokenText }
          adoptMemory(result, requestText, displayText)
          val delegatedId = delegatedConversationId(result)
          handler.post {
            update(
              if (delegatedId != null) "Agent is working. You can dismiss this overlay." else "Done",
              displayText.takeIf(String::isNotBlank)
            )
            if (spokenText.isNotBlank()) speak(spokenText)
          }
          if (delegatedId != null) {
            poll(config.serverUrl, config.workspaceId, config.authToken, delegatedId, update)
          }
        }
      }
    })
  }

  /** Adopts server-side compaction, then appends this turn to the memory. */
  private fun adoptMemory(result: JSONObject, userText: String, assistantText: String) {
    synchronized(memoryLock) {
      val compaction = result.optJSONObject("compaction")
      if (compaction != null) {
        summary = compaction.optString("summary").takeIf(String::isNotBlank)
        history = compaction.optJSONArray("history") ?: JSONArray()
      }
      history.put(JSONObject().apply {
        put("role", "user")
        put("content", userText.take(2_000))
      })
      history.put(JSONObject().apply {
        put("role", "assistant")
        put("content", assistantText.take(2_000))
      })
    }
  }

  private fun delegatedConversationId(result: JSONObject): String? {
    val actions = result.optJSONArray("actions") ?: return null
    for (index in 0 until actions.length()) {
      val action = actions.optJSONObject(index) ?: continue
      if (
        action.optString("tool") in setOf("session_start", "session_message") &&
        action.optBoolean("ok")
      ) {
        val conversationId = action.optString("conversationId")
        if (conversationId.isNotBlank()) return conversationId
      }
    }
    return null
  }

  /**
   * Speaks through the server's TTS adapter stack (the same voice as the
   * web orb). Invokes [onResult] with false when synthesis or playback is
   * unavailable so callers can fall back to on-device TextToSpeech.
   */
  fun speakServer(text: String, onResult: (Boolean) -> Unit) {
    val config = PhoneControlPreferences.read(context)
    if (config.serverUrl.isBlank() || text.isBlank()) {
      onResult(false)
      return
    }
    val body = JSONObject().put("text", text.take(3_500))
    client.newCall(
      request(config.serverUrl, config.workspaceId, config.authToken, "/api/voice/tts", "POST", body)
    ).enqueue(object : Callback {
      override fun onFailure(call: Call, error: IOException) {
        handler.post { onResult(false) }
      }

      override fun onResponse(call: Call, response: Response) {
        response.use {
          val bytes = if (it.isSuccessful) it.body?.bytes() else null
          if (bytes == null || bytes.isEmpty()) {
            handler.post { onResult(false) }
            return
          }
          val file = java.io.File.createTempFile("cesium-voice", ".wav", context.cacheDir)
          file.writeBytes(bytes)
          handler.post {
            val player = android.media.MediaPlayer()
            val done = java.util.concurrent.atomic.AtomicBoolean(false)
            fun finish(ok: Boolean) {
              if (done.compareAndSet(false, true)) {
                runCatching { player.release() }
                runCatching { file.delete() }
                onResult(ok)
              }
            }
            runCatching {
              player.setDataSource(file.absolutePath)
              player.setOnCompletionListener { finish(true) }
              player.setOnErrorListener { _, _, _ ->
                finish(false)
                true
              }
              player.prepare()
              player.start()
            }.onFailure { finish(false) }
          }
        }
      }
    })
  }

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
      append(
        "\n\n[You are Cesium acting through an Android phone. You can control this " +
          "phone with the built-in \"phone\" MCP server via call_mcp_tool — e.g. " +
          "phone_screenshot, phone_snapshot, phone_apps (open apps), phone_tap, " +
          "phone_type, phone_swipe, phone_global_action, phone_settings, and " +
          "phone_secondary_display for background/off-screen apps. Prefer these tools " +
          "to actually perform the task on the device rather than only describing it.]"
      )
      if (screenshot != null) {
        append("\n\nThe attached image is the user's current screen.")
      }
      if (screenContext.isNotBlank()) {
        append("\n\nForeground screen text (call phone_snapshot for the full live tree):\n")
        append(screenContext.take(4_000))
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
        // Force agent mode: the assistant must be able to call phone MCP tools,
        // which "ask" mode blocks.
        put("mode", "agent")
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

    /**
     * Process-lifetime voice memory shared across assistant invocations.
     * Compaction is server-driven: when the controller folds old turns into
     * the running summary, [adoptMemory] replaces both fields.
     */
    private val memoryLock = Any()
    private var history = JSONArray()
    private var summary: String? = null
  }
}

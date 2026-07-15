package com.cesium.wear.direct

import com.cesium.wear.data.WatchStateStore
import com.cesium.wear.model.WatchAgentActionRequest
import com.cesium.wear.model.WatchAgentSyncEnvelope
import com.cesium.wear.model.WatchConnectionSource
import com.cesium.wear.model.WatchFocusedConversation
import com.cesium.wear.model.WatchServerConfig
import com.cesium.wear.surface.WearAgentNotificationController
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.concurrent.TimeUnit

class DirectAgentClient(
  private val stateStore: WatchStateStore,
  private val context: android.content.Context? = null,
  private val json: Json = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
  },
  private val client: OkHttpClient = OkHttpClient.Builder()
    .pingInterval(20, TimeUnit.SECONDS)
    .build()
) {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val projectionBuilder = AgentProjectionBuilder()
  private var webSocket: WebSocket? = null
  private var config: DirectAgentConfig? = null
  private var reconnectAttempt = 0
  private var manuallyClosed = false

  fun connect(config: DirectAgentConfig) {
    this.config = config
    manuallyClosed = false
    webSocket?.close(1000, "reconnect")
    val request = Request.Builder()
      .url(config.websocketUrl())
      .build()
    webSocket = client.newWebSocket(request, listener(config))
  }

  fun disconnect() {
    manuallyClosed = true
    webSocket?.close(1000, "closed")
    webSocket = null
  }

  fun sendAction(action: WatchAgentActionRequest) {
    val current = config ?: return
    val path = when (action.action) {
      "cancel" -> "/api/agents/conversations/${encode(action.conversationId)}/cancel"
      "pause" -> "/api/agents/conversations/${encode(action.conversationId)}/pause"
      "resume" -> "/api/agents/conversations/${encode(action.conversationId)}/resume"
      "answer_question" -> "/api/agents/conversations/${encode(action.conversationId)}/question"
      "answer_permission" -> "/api/agents/conversations/${encode(action.conversationId)}/permission"
      "prompt" -> "/api/agents/conversations/${encode(action.conversationId)}/prompt"
      else -> return
    }
    val body = when (action.action) {
      "answer_question" -> """{"questionId":${jsonString(action.questionId)},"answer":${jsonString(action.answer)}}"""
      "answer_permission" -> """{"requestId":${jsonString(action.requestId)},"optionId":${jsonString(action.optionId)},"cancelled":${action.cancelled == true}}"""
      "prompt" -> """{"text":${jsonString(action.text)}}"""
      else -> "{}"
    }
    post(current, path, body)
  }

  private fun listener(config: DirectAgentConfig) = object : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      reconnectAttempt = 0
      webSocket.send(
        """
        {
          "type":"subscribe",
          "conversationIds":["${escape(config.conversationId)}"],
          "sinceByConversationId":{"${escape(config.conversationId)}":0}
        }
        """.trimIndent()
      )
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      val message = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
      val projection = projectionBuilder.applySocketMessage(message) ?: return
      scope.launch {
        stateStore.saveEnvelope(
          WatchAgentSyncEnvelope(
            server = WatchServerConfig(
              label = config.serverLabel,
              baseUrl = config.serverBaseUrl,
              authToken = config.authToken
            ),
            focused = WatchFocusedConversation(
              workspaceId = config.workspaceId,
              conversationId = config.conversationId,
              lastEventSeq = projection.lastEventSeq
            ),
            projection = projection,
            source = WatchConnectionSource.DIRECT_SERVER
          )
        )
        context?.let { WearAgentNotificationController(it).update(projection) }
      }
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      if (!manuallyClosed) scheduleReconnect()
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      if (!manuallyClosed) scheduleReconnect()
    }
  }

  private fun scheduleReconnect() {
    val nextConfig = config ?: return
    reconnectAttempt += 1
    val delayMs = minOf(30_000L, 1_000L * (1L shl reconnectAttempt.coerceAtMost(5)))
    scope.launch {
      delay(delayMs)
      if (!manuallyClosed && config == nextConfig) {
        connect(nextConfig)
      }
    }
  }

  private fun post(config: DirectAgentConfig, path: String, body: String) {
    scope.launch {
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
  }

  private fun jsonString(value: String?): String =
    value?.let { json.encodeToString(it) } ?: "null"

  private fun encode(value: String): String =
    URLEncoder.encode(value, StandardCharsets.UTF_8.name())

  private fun escape(value: String): String =
    value.replace("\\", "\\\\").replace("\"", "\\\"")
}

data class DirectAgentConfig(
  val serverBaseUrl: String,
  val serverLabel: String = "Direct server",
  val workspaceId: String,
  val conversationId: String,
  val authToken: String? = null
) {
  fun websocketUrl(): String {
    val wsBase = serverBaseUrl.trimEnd('/')
      .replace(Regex("^http:"), "ws:")
      .replace(Regex("^https:"), "wss:")
    val params = mutableListOf("workspaceId=${url(workspaceId)}")
    authToken?.takeIf { it.isNotBlank() }?.let {
      params.add("access_token=${url(it)}")
    }
    return "$wsBase/ws/agent?${params.joinToString("&")}"
  }

  private fun url(value: String): String =
    URLEncoder.encode(value, StandardCharsets.UTF_8.name())
}

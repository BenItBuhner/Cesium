package com.cesium.mobile.notifications

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.core.app.RemoteInput
import com.cesium.mobile.wear.CesiumWearRelayState
import com.cesium.mobile.wear.RelayConfig
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.concurrent.TimeUnit

/**
 * Answers agent interventions straight from the notification shade - Allow /
 * Deny for permission requests and the inline reply for questions - without
 * ever opening the app. The answer is POSTed directly against the workbench
 * server (the same pattern the Wear action router uses), so it works even
 * when the app process is dead; the relay config persisted by the web bridge
 * supplies server base URL + auth.
 */
class CesiumNotificationQuickActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION_QUICK_ACTION) return
    val quickAction = intent.getStringExtra("quickAction") ?: return
    val extras = intent.extras?.let(::Bundle) ?: return
    val replyText = RemoteInput.getResultsFromIntent(intent)
      ?.getCharSequence(CesiumAgentNotification.REMOTE_INPUT_KEY)
      ?.toString()
      ?.trim()
    if (quickAction == "reply_question" && replyText.isNullOrBlank()) return
    // Network is forbidden on the receiver's main thread; goAsync keeps the
    // process alive while the answer is delivered off-thread.
    val pendingResult = goAsync()
    Thread {
      try {
        handle(context.applicationContext, quickAction, extras, replyText)
      } finally {
        pendingResult.finish()
      }
    }.start()
  }

  private fun handle(
    context: Context,
    quickAction: String,
    extras: Bundle,
    replyText: String?
  ) {
    val conversationId = extras.getString("conversationId")
    val config = CesiumWearRelayState.read(context)
    if (config == null || conversationId.isNullOrBlank()) {
      repost(context, extras, "Open Cesium to respond")
      return
    }
    val encodedId = URLEncoder.encode(conversationId, StandardCharsets.UTF_8.name())
    val route: String
    val body: String
    when (quickAction) {
      "allow_permission", "deny_permission" -> {
        val requestId = extras.getString("permissionRequestId")
        val optionId = extras.getString(
          if (quickAction == "allow_permission") "permissionAllowOptionId"
          else "permissionDenyOptionId"
        )
        if (requestId.isNullOrBlank() || optionId.isNullOrBlank()) return
        route = "/api/agents/conversations/$encodedId/permission"
        body = JSONObject()
          .put("requestId", requestId)
          .put("optionId", optionId)
          .toString()
      }
      "reply_question" -> {
        val questionId = extras.getString("questionId")
        if (questionId.isNullOrBlank()) return
        route = "/api/agents/conversations/$encodedId/question"
        body = JSONObject()
          .put("questionId", questionId)
          .put("answer", replyText ?: "")
          .toString()
      }
      else -> return
    }
    val delivered = post(config, extras.getString("workspaceId"), route, body)
    if (delivered) {
      // The intervention no longer exists server-side: strip its ids so the
      // reposted (and any restored) notification drops the answer buttons.
      // The next projection sync replaces this interim state anyway.
      extras.remove("intervention")
      extras.remove("permissionRequestId")
      extras.remove("permissionAllowOptionId")
      extras.remove("permissionDenyOptionId")
      extras.remove("questionId")
      extras.remove("shortText")
      extras.putBoolean("alert", false)
      repost(
        context,
        extras,
        when (quickAction) {
          "allow_permission" -> "Permission granted"
          "deny_permission" -> "Permission denied"
          else -> "Reply sent"
        }
      )
    } else {
      repost(context, extras, "Couldn't reach the server - open Cesium to respond")
    }
  }

  private fun repost(context: Context, extras: Bundle, body: String) {
    extras.putString("body", body)
    if (extras.getBoolean("ongoing", true)) {
      CesiumLiveUpdateStateStore.saveRun(context, extras)
    }
    context.getSystemService(NotificationManager::class.java).notify(
      CesiumAgentNotification.notificationId(extras.getString("runKey")),
      CesiumAgentNotification.build(context, extras)
    )
  }

  private fun post(
    config: RelayConfig,
    workspaceId: String?,
    route: String,
    body: String
  ): Boolean {
    val request = Request.Builder()
      .url("${config.serverBaseUrl.trimEnd('/')}$route")
      .header("content-type", "application/json")
      .header(
        "x-opencursor-workspace-id",
        workspaceId?.takeIf { it.isNotBlank() } ?: config.workspaceId
      )
      .apply {
        config.authToken?.takeIf { it.isNotBlank() }?.let {
          header("x-opencursor-session-token", it)
        }
      }
      .post(body.toRequestBody("application/json".toMediaType()))
      .build()
    return runCatching {
      client.newCall(request).execute().use { response -> response.isSuccessful }
    }.getOrDefault(false)
  }

  companion object {
    const val ACTION_QUICK_ACTION = "com.cesium.mobile.NOTIFICATION_QUICK_ACTION"

    private val client = OkHttpClient.Builder()
      .connectTimeout(10, TimeUnit.SECONDS)
      .readTimeout(20, TimeUnit.SECONDS)
      .build()
  }
}

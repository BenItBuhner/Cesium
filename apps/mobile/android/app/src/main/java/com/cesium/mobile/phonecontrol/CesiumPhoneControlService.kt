package com.cesium.mobile.phonecontrol

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import com.cesium.mobile.BuildConfig
import com.cesium.mobile.MainActivity
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

class CesiumPhoneControlService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private val client = OkHttpClient.Builder()
    .connectTimeout(10, TimeUnit.SECONDS)
    .readTimeout(30, TimeUnit.SECONDS)
    .callTimeout(35, TimeUnit.SECONDS)
    .build()
  private var activeCall: Call? = null
  private var stopped = false
  private var cursor = 0L

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    ensureNotificationChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      PhoneControlPreferences.setEnabled(this, false)
      stopControl()
      return START_NOT_STICKY
    }
    val config = PhoneControlPreferences.read(this)
    if (!config.configured) {
      stopControl()
      return START_NOT_STICKY
    }
    stopped = false
    startAsForeground("Connected to ${hostLabel(config.serverUrl)}")
    handler.removeCallbacksAndMessages(null)
    activeCall?.cancel()
    registerAndPoll()
    return START_STICKY
  }

  override fun onDestroy() {
    stopped = true
    activeCall?.cancel()
    handler.removeCallbacksAndMessages(null)
    super.onDestroy()
  }

  private fun registerAndPoll() {
    if (stopped) return
    val config = PhoneControlPreferences.read(this)
    if (!config.configured) {
      stopControl()
      return
    }
    val body = JSONObject().apply {
      put("deviceId", PhoneControlPreferences.deviceId(this@CesiumPhoneControlService))
      put("name", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
      put("capabilities", PhoneCommandExecutor.capabilities(this@CesiumPhoneControlService))
      put("appVersion", BuildConfig.VERSION_NAME)
      put("androidVersion", Build.VERSION.RELEASE)
      put("sdkInt", Build.VERSION.SDK_INT)
      put("model", Build.MODEL)
      config.deviceToken?.let { put("deviceToken", it) }
    }
    execute(
      request(
        config,
        "/api/phone-control/devices/register",
        "POST",
        body
      )
    ) { response ->
      if (response?.isSuccessful == true) {
        try {
          val registered = JSONObject(response.body?.string() ?: "{}")
          val token = registered.optString("deviceToken")
          if (token.isBlank()) {
            throw IllegalStateException("Server did not return a phone pairing token.")
          }
          poll(PhoneControlPreferences.setDeviceToken(this, token))
        } catch (error: Exception) {
          scheduleRetry(error.message ?: "Invalid phone registration response")
        }
      } else {
        scheduleRetry(response?.code?.let { "Server returned HTTP $it" } ?: "Server unavailable")
      }
    }
  }

  private fun poll(config: PhoneControlConnectionConfig) {
    if (stopped) return
    val deviceId = PhoneControlPreferences.deviceId(this)
    val path = "/api/phone-control/devices/${UriCodec.segment(deviceId)}/commands" +
      "?after=$cursor&waitMs=20000"
    execute(request(config, path, "GET", null)) { response ->
      if (response?.isSuccessful != true) {
        scheduleRetry(response?.code?.let { "Server returned HTTP $it" } ?: "Connection lost")
        return@execute
      }
      try {
        val json = JSONObject(response.body?.string() ?: "{}")
        processCommands(config, json.optJSONArray("commands") ?: JSONArray(), 0) {
          handler.postDelayed({ registerAndPoll() }, 250)
        }
      } catch (error: Exception) {
        scheduleRetry(error.message ?: "Invalid server response")
      }
    }
  }

  private fun processCommands(
    config: PhoneControlConnectionConfig,
    commands: JSONArray,
    index: Int,
    finished: () -> Unit
  ) {
    if (stopped || index >= commands.length()) {
      finished()
      return
    }
    val command = commands.optJSONObject(index)
    if (command == null) {
      processCommands(config, commands, index + 1, finished)
      return
    }
    val commandSeq = command.optLong("seq", cursor)
    val expiresAt = command.optLong("expiresAt", System.currentTimeMillis() + 30_000)
    val payload = command.optJSONObject("payload") ?: JSONObject()
    PhoneCommandExecutor.execute(
      this,
      payload,
      success = { result ->
        postResult(config, command.optString("commandId"), true, result, null, expiresAt) { acked ->
          if (acked) cursor = maxOf(cursor, commandSeq)
          processCommands(config, commands, index + 1, finished)
        }
      },
      failure = { error ->
        postResult(config, command.optString("commandId"), false, null, error, expiresAt) { acked ->
          if (acked) cursor = maxOf(cursor, commandSeq)
          processCommands(config, commands, index + 1, finished)
        }
      }
    )
  }

  private fun postResult(
    config: PhoneControlConnectionConfig,
    commandId: String,
    ok: Boolean,
    result: JSONObject?,
    error: String?,
    expiresAt: Long,
    attempt: Int = 0,
    finished: (Boolean) -> Unit
  ) {
    val deviceId = PhoneControlPreferences.deviceId(this)
    val body = JSONObject().apply {
      put("ok", ok)
      if (result != null) put("result", result)
      if (error != null) put("error", error)
    }
    execute(
      request(
        config,
        "/api/phone-control/devices/${UriCodec.segment(deviceId)}/commands/" +
          "${UriCodec.segment(commandId)}/result",
        "POST",
        body
      )
    ) { response ->
      if (response?.isSuccessful == true) {
        finished(true)
        return@execute
      }
      val retryable = response == null || response.code >= 500
      if (retryable && !stopped && System.currentTimeMillis() < expiresAt) {
        val delay = (500L * (attempt + 1)).coerceAtMost(3_000L)
        handler.postDelayed(
          {
            postResult(
              config,
              commandId,
              ok,
              result,
              error,
              expiresAt,
              attempt + 1,
              finished
            )
          },
          delay
        )
      } else {
        finished(false)
      }
    }
  }

  private fun request(
    config: PhoneControlConnectionConfig,
    path: String,
    method: String,
    json: JSONObject?
  ): Request {
    val builder = Request.Builder()
      .url("${config.serverUrl.trimEnd('/')}$path")
      .header("x-opencursor-workspace-id", config.workspaceId)
      .header("Accept", "application/json")
    config.authToken?.let { builder.header("x-opencursor-session-token", it) }
    config.deviceToken?.let { builder.header("x-cesium-phone-token", it) }
    val body = json?.toString()?.toRequestBody(JSON_MEDIA_TYPE)
    return builder.method(method, body).build()
  }

  private fun execute(request: Request, completed: (Response?) -> Unit) {
    if (stopped) return
    activeCall = client.newCall(request)
    activeCall!!.enqueue(object : Callback {
      override fun onFailure(call: Call, error: IOException) {
        if (!stopped && !call.isCanceled()) {
          handler.post { completed(null) }
        }
      }

      override fun onResponse(call: Call, response: Response) {
        handler.post {
          response.use { completed(it) }
        }
      }
    })
  }

  private fun scheduleRetry(detail: String) {
    if (stopped) return
    startAsForeground(detail)
    handler.postDelayed({ registerAndPoll() }, 5_000)
  }

  private fun stopControl() {
    stopped = true
    activeCall?.cancel()
    handler.removeCallbacksAndMessages(null)
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  private fun startAsForeground(detail: String) {
    val notification = buildNotification(detail)
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun buildNotification(detail: String): Notification {
    val openIntent = Intent(this, MainActivity::class.java)
    val pending = PendingIntent.getActivity(
      this,
      0,
      openIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    return Notification.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_dialog_info)
      .setContentTitle("Cesium phone control")
      .setContentText(detail)
      .setContentIntent(pending)
      .setOngoing(true)
      .setCategory(Notification.CATEGORY_SERVICE)
      .build()
  }

  private fun ensureNotificationChannel() {
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Phone control",
      NotificationManager.IMPORTANCE_LOW
    ).apply {
      description = "Shows when this phone is accepting commands from a Cesium server."
    }
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  private fun hostLabel(url: String): String = try {
    android.net.Uri.parse(url).host ?: url
  } catch (_: Exception) {
    url
  }

  companion object {
    const val ACTION_START = "com.cesium.mobile.phonecontrol.START"
    const val ACTION_STOP = "com.cesium.mobile.phonecontrol.STOP"
    private const val CHANNEL_ID = "cesium_phone_control"
    private const val NOTIFICATION_ID = 0xCE72
    private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

    fun start(context: Context) {
      val intent = Intent(context, CesiumPhoneControlService::class.java)
        .setAction(ACTION_START)
      if (Build.VERSION.SDK_INT >= 26) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    fun stop(context: Context) {
      context.startService(
        Intent(context, CesiumPhoneControlService::class.java).setAction(ACTION_STOP)
      )
    }
  }
}

private object UriCodec {
  fun segment(value: String): String = java.net.URLEncoder.encode(value, Charsets.UTF_8.name())
}

package com.cesium.mobile.phonecontrol

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import com.cesium.mobile.MainActivity
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class CesiumMobileControlService : Service() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val httpClient = OkHttpClient.Builder()
    .pingInterval(20, TimeUnit.SECONDS)
    .retryOnConnectionFailure(true)
    .build()
  private lateinit var executor: MobileControlExecutor
  private var socket: WebSocket? = null
  private var reconnectAttempt = 0
  private var connectionGeneration = 0
  private var stopped = false

  override fun onCreate() {
    super.onCreate()
    executor = MobileControlExecutor(this)
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_DISABLE -> {
        MobileControlPreferences.setEnabled(this, false)
        stopControl()
        return START_NOT_STICKY
      }
      ACTION_REFRESH -> {
        if (MobileControlPreferences.read(this).enabled) {
          sendRegistration()
        }
        return START_STICKY
      }
    }
    val config = MobileControlPreferences.read(this)
    if (!config.enabled || config.serverUrl.isBlank() || config.workspaceId.isBlank()) {
      stopControl()
      return START_NOT_STICKY
    }
    stopped = false
    startAsForeground("Connecting to ${serverLabel(config.serverUrl)}")
    connect(config)
    return START_STICKY
  }

  override fun onDestroy() {
    stopped = true
    connectionGeneration += 1
    socket?.close(1000, "Cesium mobile control stopped")
    socket = null
    executor.close()
    httpClient.dispatcher.executorService.shutdown()
    updateState("disabled", null)
    super.onDestroy()
  }

  private fun connect(config: MobileControlConnectionConfig) {
    connectionGeneration += 1
    val generation = connectionGeneration
    socket?.cancel()
    socket = null
    val url = buildMobileControlRequestUrl(config.serverUrl, config.workspaceId)
      ?: run {
        updateState("error", "Invalid Cesium server URL.")
        return
      }
    val request = Request.Builder()
      .url(url)
      .apply {
        config.authToken?.let { header("x-opencursor-session-token", it) }
      }
      .build()
    updateState(if (reconnectAttempt > 0) "reconnecting" else "connecting", null)
    socket = httpClient.newWebSocket(request, object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        if (generation != connectionGeneration) {
          webSocket.close(1000, "Stale connection")
          return
        }
        reconnectAttempt = 0
        updateState("connected", null)
        startAsForeground("Connected to ${serverLabel(config.serverUrl)}")
        sendRegistration(webSocket)
      }

      override fun onMessage(webSocket: WebSocket, text: String) {
        if (generation != connectionGeneration) return
        handleMessage(webSocket, text)
      }

      override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        webSocket.close(code, reason)
      }

      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        if (generation == connectionGeneration && !stopped) scheduleReconnect(generation)
      }

      override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
        if (generation != connectionGeneration || stopped) return
        updateState("reconnecting", error.message ?: "Connection failed.")
        scheduleReconnect(generation)
      }
    })
  }

  private fun handleMessage(webSocket: WebSocket, text: String) {
    val message = try {
      JSONObject(text)
    } catch (_: Throwable) {
      return
    }
    when (message.optString("type")) {
      "connected" -> sendRegistration(webSocket)
      "ping" -> webSocket.send(JSONObject().put("type", "pong").toString())
      "registered" -> updateState("connected", null)
      "invoke" -> {
        val requestId = message.optString("requestId")
        val toolName = message.optString("toolName")
        val arguments = message.optJSONObject("arguments") ?: JSONObject()
        if (requestId.isBlank() || toolName.isBlank()) return
        executor.execute(toolName, arguments) { result ->
          val response = JSONObject()
            .put("type", "result")
            .put("requestId", requestId)
          result.fold(
            onSuccess = { response.put("ok", true).put("result", it) },
            onFailure = {
              response
                .put("ok", false)
                .put("error", it.message ?: it.javaClass.simpleName)
            }
          )
          webSocket.send(response.toString())
        }
      }
    }
  }

  private fun sendRegistration(target: WebSocket? = socket) {
    val webSocket = target ?: return
    val capabilities = JSONArray()
      .put("device_info")
      .put("open_apps")
      .put("device_settings")
    if (packageManager.hasSystemFeature(PackageManager.FEATURE_ACTIVITIES_ON_SECONDARY_DISPLAYS)) {
      capabilities.put("private_display")
    }
    if (CesiumAccessibilityService.isConnected()) {
      capabilities.put("screen_capture")
      capabilities.put("ui_automation")
    }
    val message = JSONObject()
      .put("type", "register")
      .put("device", JSONObject()
        .put("id", MobileControlPreferences.stableDeviceId(this))
        .put("name", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
        .put("platform", "android")
        .put("apiLevel", Build.VERSION.SDK_INT)
        .put("appVersion", appVersion()))
      .put("capabilities", capabilities)
    webSocket.send(message.toString())
  }

  private fun scheduleReconnect(generation: Int) {
    if (generation != connectionGeneration || stopped) return
    reconnectAttempt += 1
    val delay = (1000L shl reconnectAttempt.coerceAtMost(5)).coerceAtMost(30_000L)
    mainHandler.postDelayed({
      if (generation == connectionGeneration && !stopped) {
        val config = MobileControlPreferences.read(this)
        if (config.enabled) connect(config)
      }
    }, delay)
  }

  private fun stopControl() {
    stopped = true
    connectionGeneration += 1
    socket?.close(1000, "Disabled by user")
    socket = null
    stopForeground(STOP_FOREGROUND_REMOVE)
    updateState("disabled", null)
    stopSelf()
  }

  private fun startAsForeground(content: String) {
    ensureNotificationChannel()
    val openIntent = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val disableIntent = PendingIntent.getService(
      this,
      1,
      Intent(this, CesiumMobileControlService::class.java).setAction(ACTION_DISABLE),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val notification = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
      .setContentTitle("Cesium mobile control")
      .setContentText(content)
      .setContentIntent(openIntent)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .addAction(0, "Disconnect", disableIntent)
      .build()
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

  private fun ensureNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java)
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    manager.createNotificationChannel(
      NotificationChannel(
        CHANNEL_ID,
        "Mobile control",
        NotificationManager.IMPORTANCE_LOW
      ).apply {
        description = "Persistent connection for user-enabled Cesium phone control"
        setShowBadge(false)
      }
    )
  }

  private fun appVersion(): String =
    try {
      packageManager.getPackageInfo(packageName, 0).versionName ?: "unknown"
    } catch (_: Throwable) {
      "unknown"
    }

  private fun serverLabel(url: String): String =
    url.toHttpUrlOrNull()?.host ?: url

  companion object {
    const val ACTION_START = "com.cesium.mobile.control.START"
    const val ACTION_DISABLE = "com.cesium.mobile.control.DISABLE"
    const val ACTION_REFRESH = "com.cesium.mobile.control.REFRESH"
    private const val CHANNEL_ID = "cesium-mobile-control"
    private const val NOTIFICATION_ID = 6110

    @Volatile
    private var connectionState = "disabled"
    @Volatile
    private var lastError: String? = null

    private fun updateState(state: String, error: String?) {
      connectionState = state
      lastError = error
    }

    fun status(context: Context): JSONObject {
      val config = MobileControlPreferences.read(context)
      return JSONObject()
        .put("enabled", config.enabled)
        .put("connectionState", connectionState)
        .put("lastError", lastError)
        .put("serverUrl", config.serverUrl)
        .put("workspaceId", config.workspaceId)
        .put("deviceId", MobileControlPreferences.stableDeviceId(context))
        .put("accessibilityEnabled", CesiumAccessibilityService.isConnected())
        .put("assistantSelected", CesiumPhoneControlModule.isAssistantSelected(context))
        .put("assistantRoleAvailable", CesiumPhoneControlModule.isAssistantRoleAvailable(context))
        .put("hotwordMode", "oem_dependent")
        .put(
          "privateDisplaySupported",
          context.packageManager.hasSystemFeature(
            PackageManager.FEATURE_ACTIVITIES_ON_SECONDARY_DISPLAYS
          )
        )
    }

    fun requestCapabilityRefresh(context: Context) {
      if (!MobileControlPreferences.read(context).enabled) return
      try {
        context.startService(
          Intent(context, CesiumMobileControlService::class.java).setAction(ACTION_REFRESH)
        )
      } catch (_: Throwable) {
        // The next reconnect or app foreground will refresh capabilities.
      }
    }
  }
}

package com.cesium.mobile.phonecontrol

import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Display
import org.json.JSONObject

class MobileControlExecutor(private val context: Context) {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val privateDisplays = PrivateDisplayController(context)

  fun execute(
    toolName: String,
    arguments: JSONObject,
    callback: (Result<JSONObject>) -> Unit
  ) {
    mainHandler.post {
      try {
        when (toolName) {
          "mobile_open_app" -> callback(Result.success(openApp(arguments)))
          "mobile_screen_snapshot" -> screenSnapshot(arguments, callback)
          "mobile_ui_tree" -> callback(Result.success(uiTree(arguments)))
          "mobile_tap" -> tap(arguments, callback)
          "mobile_swipe" -> swipe(arguments, callback)
          "mobile_type_text" -> callback(Result.success(typeText(arguments)))
          "mobile_global_action" -> callback(Result.success(globalAction(arguments)))
          "mobile_private_display" -> callback(Result.success(privateDisplay(arguments)))
          "mobile_launch_on_display" ->
            callback(Result.success(privateDisplays.launch(
              requireInt(arguments, "displayId"),
              arguments.optionalString("packageName"),
              arguments.optionalString("uri")
            )))
          "mobile_open_settings" -> callback(Result.success(openSettings(arguments)))
          "mobile_set_volume" -> callback(Result.success(setVolume(arguments)))
          else -> callback(Result.failure(IllegalArgumentException("Unknown mobile tool: $toolName")))
        }
      } catch (error: Throwable) {
        callback(Result.failure(error))
      }
    }
  }

  fun close() {
    privateDisplays.close()
  }

  private fun openApp(arguments: JSONObject): JSONObject {
    val displayId = arguments.optionalInt("displayId")
    val packageName = arguments.optionalString("packageName")
    val uri = arguments.optionalString("uri")
    if (displayId != null && displayId != Display.DEFAULT_DISPLAY) {
      return privateDisplays.launch(displayId, packageName, uri)
    }
    val intent = when {
      !uri.isNullOrBlank() -> Intent(Intent.ACTION_VIEW, Uri.parse(uri)).apply {
        if (!packageName.isNullOrBlank()) setPackage(packageName)
      }
      !packageName.isNullOrBlank() ->
        context.packageManager.getLaunchIntentForPackage(packageName)
          ?: Intent(Intent.ACTION_MAIN).apply {
            addCategory(Intent.CATEGORY_LAUNCHER)
            setPackage(packageName)
          }
      else -> throw IllegalArgumentException("Provide packageName or uri.")
    }.apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    context.startActivity(intent)
    return JSONObject()
      .put("ok", true)
      .put("action", "open_app_requested")
      .put("packageName", packageName)
      .put("uri", uri)
      .put(
        "verification",
        "Android accepted the launch request. Observe the screen before claiming the target app is ready."
      )
  }

  private fun screenSnapshot(
    arguments: JSONObject,
    callback: (Result<JSONObject>) -> Unit
  ) {
    val displayId = arguments.optInt("displayId", Display.DEFAULT_DISPLAY)
    val includeImage = arguments.optBoolean("includeImage", true)
    val includeHierarchy = arguments.optBoolean("includeHierarchy", true)
    val format = arguments.optString("imageFormat", "jpeg")
    val quality = arguments.optInt("quality", 70)
    val accessibility = CesiumAccessibilityService.current
    val result = JSONObject()
      .put("ok", true)
      .put("displayId", displayId)
      .put("capturedAt", System.currentTimeMillis())

    if (includeHierarchy) {
      if (accessibility == null) {
        result.put("hierarchyError", "Cesium accessibility control is not enabled.")
      } else {
        result.put("hierarchy", accessibility.hierarchy(displayId, 400))
      }
    }
    if (!includeImage) {
      callback(Result.success(result))
      return
    }
    if (privateDisplays.contains(displayId)) {
      result.put("image", privateDisplays.capture(displayId, format, quality))
      callback(Result.success(result))
      return
    }
    if (accessibility == null) {
      callback(Result.failure(IllegalStateException(
        "Enable Cesium accessibility control before capturing the physical screen."
      )))
      return
    }
    accessibility.screenshot(displayId, format, quality) { screenshot ->
      callback(screenshot.map { result.put("image", it) })
    }
  }

  private fun uiTree(arguments: JSONObject): JSONObject {
    val service = requireAccessibility()
    val displayId = arguments.optInt("displayId", Display.DEFAULT_DISPLAY)
    return JSONObject()
      .put("ok", true)
      .put("hierarchy", service.hierarchy(displayId, arguments.optInt("maxNodes", 400)))
  }

  private fun tap(arguments: JSONObject, callback: (Result<JSONObject>) -> Unit) {
    val service = requireAccessibility()
    val displayId = arguments.optInt("displayId", Display.DEFAULT_DISPLAY)
    service.tap(
      displayId,
      requireDouble(arguments, "x").toFloat(),
      requireDouble(arguments, "y").toFloat(),
      arguments.optLong("durationMs", 80)
    ) { completed ->
      callback(Result.success(actionResult(completed, "tap_dispatched", displayId)))
    }
  }

  private fun swipe(arguments: JSONObject, callback: (Result<JSONObject>) -> Unit) {
    val service = requireAccessibility()
    val displayId = arguments.optInt("displayId", Display.DEFAULT_DISPLAY)
    service.swipe(
      displayId,
      requireDouble(arguments, "startX").toFloat(),
      requireDouble(arguments, "startY").toFloat(),
      requireDouble(arguments, "endX").toFloat(),
      requireDouble(arguments, "endY").toFloat(),
      arguments.optLong("durationMs", 400)
    ) { completed ->
      callback(Result.success(actionResult(completed, "swipe_dispatched", displayId)))
    }
  }

  private fun typeText(arguments: JSONObject): JSONObject {
    val text = arguments.optString("text", "")
    if (!arguments.has("text")) throw IllegalArgumentException("mobile_type_text requires text.")
    return actionResult(
      requireAccessibility().typeText(text, arguments.optBoolean("append", false)),
      "text_set",
      Display.DEFAULT_DISPLAY
    )
  }

  private fun globalAction(arguments: JSONObject): JSONObject {
    val action = arguments.optString("action", "")
    if (action.isBlank()) throw IllegalArgumentException("mobile_global_action requires action.")
    return actionResult(
      requireAccessibility().globalAction(action),
      "global_action_$action",
      Display.DEFAULT_DISPLAY
    )
  }

  private fun privateDisplay(arguments: JSONObject): JSONObject {
    return when (val action = arguments.optString("action", "")) {
      "create" -> JSONObject()
        .put("ok", true)
        .put("action", "private_display_created")
        .put("display", privateDisplays.create(
          arguments.optInt("width", 1080),
          arguments.optInt("height", 1920),
          arguments.optInt("densityDpi", 420)
        ))
      "list" -> JSONObject().put("ok", true).put("displays", privateDisplays.list())
      "capture" -> {
        val displayId = requireInt(arguments, "displayId")
        JSONObject()
          .put("ok", true)
          .put("action", "private_display_captured")
          .put("image", privateDisplays.capture(
            displayId,
            arguments.optString("imageFormat", "jpeg"),
            arguments.optInt("quality", 70)
          ))
      }
      "destroy" -> {
        val displayId = requireInt(arguments, "displayId")
        JSONObject()
          .put("ok", privateDisplays.destroy(displayId))
          .put("action", "private_display_destroyed")
          .put("displayId", displayId)
      }
      else -> throw IllegalArgumentException(
        "mobile_private_display action must be create, list, capture, or destroy."
      )
    }
  }

  private fun openSettings(arguments: JSONObject): JSONObject {
    val panel = arguments.optString("panel", "")
    val action = when (panel) {
      "wifi" -> Settings.ACTION_WIFI_SETTINGS
      "bluetooth" -> Settings.ACTION_BLUETOOTH_SETTINGS
      "accessibility" -> Settings.ACTION_ACCESSIBILITY_SETTINGS
      "assistant" -> Settings.ACTION_VOICE_INPUT_SETTINGS
      "notifications" -> Settings.ACTION_APP_NOTIFICATION_SETTINGS
      "location" -> Settings.ACTION_LOCATION_SOURCE_SETTINGS
      "app_details" -> Settings.ACTION_APPLICATION_DETAILS_SETTINGS
      else -> throw IllegalArgumentException("Unsupported Android settings panel: $panel")
    }
    val intent = Intent(action).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      if (panel == "notifications") putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
      if (panel == "app_details") data = Uri.parse("package:${context.packageName}")
    }
    context.startActivity(intent)
    return JSONObject().put("ok", true).put("action", "settings_opened").put("panel", panel)
  }

  private fun setVolume(arguments: JSONObject): JSONObject {
    val manager = context.getSystemService(AudioManager::class.java)
    val streamName = arguments.optString("stream", "media")
    val stream = when (streamName) {
      "ring" -> AudioManager.STREAM_RING
      "alarm" -> AudioManager.STREAM_ALARM
      "notification" -> AudioManager.STREAM_NOTIFICATION
      "voice_call" -> AudioManager.STREAM_VOICE_CALL
      else -> AudioManager.STREAM_MUSIC
    }
    val percent = requireInt(arguments, "percent").coerceIn(0, 100)
    val max = manager.getStreamMaxVolume(stream)
    val volume = ((percent / 100.0) * max).toInt().coerceIn(0, max)
    manager.setStreamVolume(stream, volume, AudioManager.FLAG_SHOW_UI)
    return JSONObject()
      .put("ok", true)
      .put("action", "volume_set")
      .put("stream", streamName)
      .put("percent", percent)
      .put("level", volume)
      .put("maxLevel", max)
  }

  private fun requireAccessibility(): CesiumAccessibilityService =
    CesiumAccessibilityService.current
      ?: throw IllegalStateException(
        "Cesium accessibility control is not enabled. The user must enable it in Android Settings."
      )

  private fun actionResult(ok: Boolean, action: String, displayId: Int): JSONObject =
    JSONObject()
      .put("ok", ok)
      .put("action", action)
      .put("displayId", displayId)
      .put("verifiedScreenEffect", false)
      .put(
        "verification",
        "Observe with mobile_screen_snapshot or mobile_ui_tree before claiming the UI changed."
      )

  private fun requireInt(arguments: JSONObject, key: String): Int {
    if (!arguments.has(key)) throw IllegalArgumentException("$key is required.")
    return arguments.getInt(key)
  }

  private fun requireDouble(arguments: JSONObject, key: String): Double {
    if (!arguments.has(key)) throw IllegalArgumentException("$key is required.")
    return arguments.getDouble(key)
  }
}

private fun JSONObject.optionalString(key: String): String? =
  if (has(key) && !isNull(key)) optString(key).takeIf { it.isNotBlank() } else null

private fun JSONObject.optionalInt(key: String): Int? =
  if (has(key) && !isNull(key)) getInt(key) else null

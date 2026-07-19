package com.cesium.mobile.phonecontrol

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ComponentName
import android.content.Context
import android.graphics.Bitmap
import android.graphics.ColorSpace
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

class CesiumAccessibilityService : AccessibilityService() {
  override fun onServiceConnected() {
    instance = this
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit

  override fun onInterrupt() = Unit

  override fun onDestroy() {
    if (instance === this) {
      instance = null
    }
    super.onDestroy()
  }

  fun execute(
    payload: JSONObject,
    success: (JSONObject) -> Unit,
    failure: (String) -> Unit
  ) {
    when (payload.optString("type")) {
      "get_status" -> success(statusJson(this))
      "snapshot" -> snapshot(payload.optInt("maxNodes", 250), success, failure)
      "screenshot" -> screenshot(payload.optInt("quality", 72), success, failure)
      "tap" -> tap(payload, success, failure)
      "long_press" -> longPress(payload, success, failure)
      "swipe" -> swipe(payload, success, failure)
      "type_text" -> typeText(payload, success, failure)
      "global_action" -> globalAction(payload, success, failure)
      else -> failure("Unsupported accessibility command.")
    }
  }

  private fun snapshot(
    requestedMaxNodes: Int,
    success: (JSONObject) -> Unit,
    failure: (String) -> Unit
  ) {
    val root = rootInActiveWindow ?: run {
      failure("No active accessibility window is available.")
      return
    }
    val maxNodes = requestedMaxNodes.coerceIn(1, 500)
    val nodes = JSONArray()
    var count = 0

    fun visit(node: AccessibilityNodeInfo, ref: String) {
      if (count >= maxNodes) return
      count += 1
      val bounds = Rect()
      node.getBoundsInScreen(bounds)
      nodes.put(JSONObject().apply {
        put("ref", ref)
        put("text", node.text?.toString() ?: JSONObject.NULL)
        put("contentDescription", node.contentDescription?.toString() ?: JSONObject.NULL)
        put("className", node.className?.toString() ?: JSONObject.NULL)
        put("packageName", node.packageName?.toString() ?: JSONObject.NULL)
        put("viewId", node.viewIdResourceName ?: JSONObject.NULL)
        put("bounds", JSONObject().apply {
          put("left", bounds.left)
          put("top", bounds.top)
          put("right", bounds.right)
          put("bottom", bounds.bottom)
        })
        put("clickable", node.isClickable)
        put("editable", node.isEditable)
        put("focusable", node.isFocusable)
        put("focused", node.isFocused)
        put("scrollable", node.isScrollable)
        put("enabled", node.isEnabled)
        put("actions", JSONArray().apply {
          node.actionList.forEach { action ->
            put(action.label?.toString() ?: action.id)
          }
        })
      })
      for (index in 0 until node.childCount) {
        if (count >= maxNodes) break
        node.getChild(index)?.let { child -> visit(child, "$ref.$index") }
      }
    }

    visit(root, "0")
    val windowsJson = JSONArray()
    windows.forEach { window ->
      windowsJson.put(JSONObject().apply {
        put("id", window.id)
        put("type", window.type)
        put("title", window.title?.toString() ?: JSONObject.NULL)
        put("active", window.isActive)
        put("focused", window.isFocused)
      })
    }
    success(JSONObject().apply {
      put("packageName", root.packageName?.toString() ?: JSONObject.NULL)
      put("className", root.className?.toString() ?: JSONObject.NULL)
      put("nodes", nodes)
      put("windows", windowsJson)
      put("nodeCount", count)
      put("truncated", count >= maxNodes)
    })
  }

  private fun tap(
    payload: JSONObject,
    success: (JSONObject) -> Unit,
    failure: (String) -> Unit
  ) {
    val text = payload.optString("text").takeIf { it.isNotBlank() }
    val viewId = payload.optString("viewId").takeIf { it.isNotBlank() }
    if (text != null || viewId != null) {
      val target = findNode(text, viewId)
      if (target == null) {
        failure("No accessibility node matched the requested text or view id.")
        return
      }
      var clickable: AccessibilityNodeInfo? = target
      while (clickable != null && !clickable.isClickable) {
        clickable = clickable.parent
      }
      if (clickable?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true) {
        success(JSONObject().put("dispatched", true).put("method", "accessibility_click"))
        return
      }
      val bounds = Rect()
      target.getBoundsInScreen(bounds)
      dispatchTap(bounds.exactCenterX(), bounds.exactCenterY(), 80, success, failure)
      return
    }
    if (!payload.has("x") || !payload.has("y")) {
      failure("Tap requires text, viewId, or x and y coordinates.")
      return
    }
    dispatchTap(
      payload.optDouble("x").toFloat(),
      payload.optDouble("y").toFloat(),
      80,
      success,
      failure
    )
  }

  private fun longPress(
    payload: JSONObject,
    success: (JSONObject) -> Unit,
    failure: (String) -> Unit
  ) {
    dispatchTap(
      payload.optDouble("x").toFloat(),
      payload.optDouble("y").toFloat(),
      payload.optInt("durationMs", 700).coerceIn(300, 5_000),
      success,
      failure
    )
  }

  private fun dispatchTap(
    x: Float,
    y: Float,
    durationMs: Int,
    success: (JSONObject) -> Unit,
    failure: (String) -> Unit
  ) {
    val path = Path().apply { moveTo(x, y) }
    val gesture = GestureDescription.Builder()
      .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs.toLong()))
      .build()
    dispatchGesture(gesture, object : GestureResultCallback() {
      override fun onCompleted(gestureDescription: GestureDescription?) {
        success(JSONObject().put("dispatched", true).put("method", "gesture"))
      }

      override fun onCancelled(gestureDescription: GestureDescription?) {
        failure("Android cancelled the gesture.")
      }
    }, null)
  }

  private fun swipe(
    payload: JSONObject,
    success: (JSONObject) -> Unit,
    failure: (String) -> Unit
  ) {
    val path = Path().apply {
      moveTo(payload.optDouble("startX").toFloat(), payload.optDouble("startY").toFloat())
      lineTo(payload.optDouble("endX").toFloat(), payload.optDouble("endY").toFloat())
    }
    val gesture = GestureDescription.Builder()
      .addStroke(
        GestureDescription.StrokeDescription(
          path,
          0,
          payload.optInt("durationMs", 400).coerceIn(100, 5_000).toLong()
        )
      )
      .build()
    dispatchGesture(gesture, object : GestureResultCallback() {
      override fun onCompleted(gestureDescription: GestureDescription?) {
        success(JSONObject().put("dispatched", true))
      }

      override fun onCancelled(gestureDescription: GestureDescription?) {
        failure("Android cancelled the swipe.")
      }
    }, null)
  }

  private fun typeText(
    payload: JSONObject,
    success: (JSONObject) -> Unit,
    failure: (String) -> Unit
  ) {
    val target = findNode(
      payload.optString("targetText").takeIf { it.isNotBlank() },
      payload.optString("viewId").takeIf { it.isNotBlank() }
    ) ?: findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
    if (target == null) {
      failure("No editable or focused accessibility node is available.")
      return
    }
    val requested = payload.optString("text")
    val value = if (payload.optBoolean("replace", true)) {
      requested
    } else {
      "${target.text ?: ""}$requested"
    }
    val arguments = Bundle().apply {
      putCharSequence(
        AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
        value
      )
    }
    if (!target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)) {
      failure("The target app rejected ACTION_SET_TEXT.")
      return
    }
    success(JSONObject().put("dispatched", true).put("characters", requested.length))
  }

  private fun globalAction(
    payload: JSONObject,
    success: (JSONObject) -> Unit,
    failure: (String) -> Unit
  ) {
    val action = when (payload.optString("action")) {
      "back" -> GLOBAL_ACTION_BACK
      "home" -> GLOBAL_ACTION_HOME
      "recents" -> GLOBAL_ACTION_RECENTS
      "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
      "quick_settings" -> GLOBAL_ACTION_QUICK_SETTINGS
      "power_dialog" -> GLOBAL_ACTION_POWER_DIALOG
      "lock_screen" -> if (Build.VERSION.SDK_INT >= 28) GLOBAL_ACTION_LOCK_SCREEN else -1
      "take_screenshot" -> if (Build.VERSION.SDK_INT >= 28) GLOBAL_ACTION_TAKE_SCREENSHOT else -1
      else -> -1
    }
    if (action < 0 || !performGlobalAction(action)) {
      failure("Android rejected or does not support this global action.")
      return
    }
    success(JSONObject().put("dispatched", true))
  }

  private fun screenshot(
    requestedQuality: Int,
    success: (JSONObject) -> Unit,
    failure: (String) -> Unit
  ) {
    if (Build.VERSION.SDK_INT < 30) {
      failure("Accessibility screenshots require Android 11 or newer.")
      return
    }
    takeScreenshot(
      Display.DEFAULT_DISPLAY,
      mainExecutor,
      object : TakeScreenshotCallback {
        override fun onSuccess(screenshot: ScreenshotResult) {
          try {
            val colorSpace = screenshot.colorSpace ?: ColorSpace.get(ColorSpace.Named.SRGB)
            val wrapped = Bitmap.wrapHardwareBuffer(screenshot.hardwareBuffer, colorSpace)
              ?: throw IllegalStateException("Android returned an unreadable screenshot buffer.")
            val width = wrapped.width
            val height = wrapped.height
            val bitmap = wrapped.copy(Bitmap.Config.ARGB_8888, false)
            screenshot.hardwareBuffer.close()
            val output = ByteArrayOutputStream()
            val quality = requestedQuality.coerceIn(30, 95)
            bitmap.compress(Bitmap.CompressFormat.JPEG, quality, output)
            bitmap.recycle()
            val encoded = android.util.Base64.encodeToString(
              output.toByteArray(),
              android.util.Base64.NO_WRAP
            )
            success(JSONObject().apply {
              put("mimeType", "image/jpeg")
              put("imageDataUrl", "data:image/jpeg;base64,$encoded")
              put("width", width)
              put("height", height)
            })
          } catch (error: Exception) {
            failure(error.message ?: "Failed to encode screenshot.")
          }
        }

        override fun onFailure(errorCode: Int) {
          failure("Android screenshot failed with code $errorCode.")
        }
      }
    )
  }

  private fun findNode(text: String?, viewId: String?): AccessibilityNodeInfo? {
    val root = rootInActiveWindow ?: return null
    if (viewId != null) {
      root.findAccessibilityNodeInfosByViewId(viewId).firstOrNull()?.let { return it }
    }
    if (text != null) {
      root.findAccessibilityNodeInfosByText(text).firstOrNull()?.let { return it }
    }
    return null
  }

  companion object {
    @Volatile
    var instance: CesiumAccessibilityService? = null
      private set

    fun isEnabled(context: Context): Boolean {
      val expected = ComponentName(context, CesiumAccessibilityService::class.java)
        .flattenToString()
      val enabled = Settings.Secure.getString(
        context.contentResolver,
        Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
      ) ?: return false
      return enabled.split(':').any { it.equals(expected, ignoreCase = true) }
    }

    fun statusJson(context: Context): JSONObject {
      val connected = instance != null
      return JSONObject().apply {
        put("accessibilityEnabled", isEnabled(context))
        put("accessibilityConnected", connected)
        put("screenSnapshot", connected)
        put("screenCapture", connected && Build.VERSION.SDK_INT >= 30)
        put("gestures", connected)
        put("textInput", connected)
        put("globalActions", connected)
      }
    }
  }
}

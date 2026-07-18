package com.cesium.mobile.phonecontrol

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Bitmap
import android.graphics.ColorSpace
import android.graphics.Path
import android.os.Build
import android.os.Bundle
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.Base64

class CesiumAccessibilityService : AccessibilityService() {
  override fun onServiceConnected() {
    super.onServiceConnected()
    current = this
    CesiumMobileControlService.requestCapabilityRefresh(this)
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit

  override fun onInterrupt() = Unit

  override fun onDestroy() {
    if (current === this) current = null
    CesiumMobileControlService.requestCapabilityRefresh(this)
    super.onDestroy()
  }

  fun hierarchy(displayId: Int, maxNodes: Int): JSONObject {
    val root = rootForDisplay(displayId)
      ?: throw IllegalStateException("No accessibility hierarchy is available for display $displayId.")
    val counter = intArrayOf(0)
    return JSONObject()
      .put("displayId", displayId)
      .put("capturedAt", System.currentTimeMillis())
      .put("root", nodeToJson(root, counter, maxNodes.coerceIn(1, 1000)))
      .put("nodeCount", counter[0])
      .put("truncated", counter[0] >= maxNodes)
  }

  fun screenshot(
    displayId: Int,
    format: String,
    quality: Int,
    callback: (Result<JSONObject>) -> Unit
  ) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      callback(Result.failure(IllegalStateException("Accessibility screenshots require Android 11.")))
      return
    }
    takeScreenshot(
      displayId,
      mainExecutor,
      object : TakeScreenshotCallback {
        override fun onSuccess(result: ScreenshotResult) {
          try {
            val colorSpace = result.colorSpace ?: ColorSpace.get(ColorSpace.Named.SRGB)
            val hardware = Bitmap.wrapHardwareBuffer(result.hardwareBuffer, colorSpace)
              ?: throw IllegalStateException("Android returned an unreadable screenshot buffer.")
            val bitmap = hardware.copy(Bitmap.Config.ARGB_8888, false)
            result.hardwareBuffer.close()
            callback(Result.success(encodeBitmap(bitmap, displayId, format, quality)))
            bitmap.recycle()
          } catch (error: Throwable) {
            callback(Result.failure(error))
          }
        }

        override fun onFailure(errorCode: Int) {
          callback(Result.failure(IllegalStateException("Android screenshot failed with code $errorCode.")))
        }
      }
    )
  }

  fun tap(
    displayId: Int,
    x: Float,
    y: Float,
    durationMs: Long,
    callback: (Boolean) -> Unit
  ) {
    gesture(
      displayId,
      Path().apply { moveTo(x, y) },
      durationMs.coerceIn(1L, 2000L),
      callback
    )
  }

  fun swipe(
    displayId: Int,
    startX: Float,
    startY: Float,
    endX: Float,
    endY: Float,
    durationMs: Long,
    callback: (Boolean) -> Unit
  ) {
    gesture(
      displayId,
      Path().apply {
        moveTo(startX, startY)
        lineTo(endX, endY)
      },
      durationMs.coerceIn(50L, 5000L),
      callback
    )
  }

  fun typeText(text: String, append: Boolean): Boolean {
    val root = rootInActiveWindow ?: return false
    val focused =
      root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        ?: findEditable(root)
        ?: return false
    val next = if (append) "${focused.text?.toString().orEmpty()}$text" else text
    return focused.performAction(
      AccessibilityNodeInfo.ACTION_SET_TEXT,
      Bundle().apply {
        putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, next)
      }
    )
  }

  fun globalAction(name: String): Boolean {
    val action = when (name) {
      "back" -> GLOBAL_ACTION_BACK
      "home" -> GLOBAL_ACTION_HOME
      "recents" -> GLOBAL_ACTION_RECENTS
      "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
      "quick_settings" -> GLOBAL_ACTION_QUICK_SETTINGS
      "power_dialog" -> GLOBAL_ACTION_POWER_DIALOG
      "lock_screen" -> if (Build.VERSION.SDK_INT >= 28) GLOBAL_ACTION_LOCK_SCREEN else return false
      "take_screenshot" ->
        if (Build.VERSION.SDK_INT >= 28) GLOBAL_ACTION_TAKE_SCREENSHOT else return false
      else -> return false
    }
    return performGlobalAction(action)
  }

  private fun gesture(
    displayId: Int,
    path: Path,
    durationMs: Long,
    callback: (Boolean) -> Unit
  ) {
    val builder = GestureDescription.Builder()
      .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs))
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      builder.setDisplayId(displayId)
    } else if (displayId != Display.DEFAULT_DISPLAY) {
      callback(false)
      return
    }
    val accepted = dispatchGesture(
      builder.build(),
      object : GestureResultCallback() {
        override fun onCompleted(gestureDescription: GestureDescription?) = callback(true)
        override fun onCancelled(gestureDescription: GestureDescription?) = callback(false)
      },
      null
    )
    if (!accepted) callback(false)
  }

  private fun rootForDisplay(displayId: Int): AccessibilityNodeInfo? {
    if (displayId == Display.DEFAULT_DISPLAY || Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      return rootInActiveWindow
    }
    val windows = windowsOnAllDisplays[displayId] ?: return null
    return (windows.firstOrNull { it.isActive } ?: windows.firstOrNull())?.root
  }

  private fun nodeToJson(
    node: AccessibilityNodeInfo,
    counter: IntArray,
    maxNodes: Int
  ): JSONObject {
    counter[0] += 1
    val bounds = android.graphics.Rect().also(node::getBoundsInScreen)
    val value = JSONObject()
      .put("className", node.className?.toString())
      .put("packageName", node.packageName?.toString())
      .put("viewId", node.viewIdResourceName)
      .put("text", if (node.isPassword) "[redacted]" else node.text?.toString())
      .put("contentDescription", node.contentDescription?.toString())
      .put("bounds", JSONObject()
        .put("left", bounds.left)
        .put("top", bounds.top)
        .put("right", bounds.right)
        .put("bottom", bounds.bottom))
      .put("clickable", node.isClickable)
      .put("editable", node.isEditable)
      .put("enabled", node.isEnabled)
      .put("focused", node.isFocused)
      .put("scrollable", node.isScrollable)
      .put("selected", node.isSelected)

    val children = JSONArray()
    for (index in 0 until node.childCount) {
      if (counter[0] >= maxNodes) break
      node.getChild(index)?.let { child ->
        children.put(nodeToJson(child, counter, maxNodes))
      }
    }
    return value.put("children", children)
  }

  private fun findEditable(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
    if (node.isEditable && node.isEnabled) return node
    for (index in 0 until node.childCount) {
      val match = node.getChild(index)?.let(::findEditable)
      if (match != null) return match
    }
    return null
  }

  companion object {
    @Volatile
    var current: CesiumAccessibilityService? = null
      private set

    fun isConnected(): Boolean = current != null

    fun encodeBitmap(
      bitmap: Bitmap,
      displayId: Int,
      format: String,
      quality: Int
    ): JSONObject {
      val normalized = if (format == "png") "png" else "jpeg"
      val bytes = ByteArrayOutputStream().use { output ->
        bitmap.compress(
          if (normalized == "png") Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG,
          quality.coerceIn(20, 100),
          output
        )
        output.toByteArray()
      }
      return JSONObject()
        .put("displayId", displayId)
        .put("width", bitmap.width)
        .put("height", bitmap.height)
        .put("mimeType", "image/$normalized")
        .put("base64", Base64.getEncoder().encodeToString(bytes))
        .put("byteLength", bytes.size)
        .put("capturedAt", System.currentTimeMillis())
    }
  }
}

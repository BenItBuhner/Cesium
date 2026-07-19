package com.cesium.mobile.phonecontrol

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
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
    // Guarantee we can enumerate windows across every display (needed to read /
    // control apps on secondary / off-screen displays), regardless of what the
    // XML config resolved to at install time.
    runCatching {
      serviceInfo = serviceInfo?.apply {
        flags = flags or
          AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS or
          AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
      }
    }
    // Control must survive without the RN UI ever opening: as soon as the user
    // enables accessibility, bring up the polling foreground service (shared
    // process, so it can reach this instance) if the device is configured.
    runCatching {
      if (PhoneControlPreferences.read(this).configured) {
        CesiumPhoneControlService.start(this)
      }
    }
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
      "snapshot" -> snapshot(payload, success, failure)
      "screenshot" -> screenshot(payload, success, failure)
      "tap" -> tap(payload, success, failure)
      "long_press" -> longPress(payload, success, failure)
      "swipe" -> swipe(payload, success, failure)
      "type_text" -> typeText(payload, success, failure)
      "global_action" -> globalAction(payload, success, failure)
      else -> failure("Unsupported accessibility command.")
    }
  }

  /**
   * Roots for a target display. displayId < 0 means the active window (default
   * display). getWindowsOnAllDisplays (API 30+) lets us read and control apps on
   * a secondary/off-screen display, not just the physical screen.
   */
  private fun rootsForDisplay(displayId: Int): List<AccessibilityNodeInfo> {
    if (displayId < 0 || displayId == Display.DEFAULT_DISPLAY) {
      val active = rootInActiveWindow
      if (active != null && displayId < 0) return listOf(active)
    }
    if (Build.VERSION.SDK_INT >= 30) {
      val all = windowsOnAllDisplays
      val list = all.get(displayId)
      if (list != null && list.isNotEmpty()) {
        return list.mapNotNull { it.root }
      }
    }
    // No windows keyed to this display: derive roots from any window whose root
    // reports the requested display id (covers displays the SparseArray misses).
    if (displayId >= 0) {
      val matches = windows.mapNotNull { it.root }
        .filter { runCatching { it.window?.displayId }.getOrNull() == displayId }
      if (matches.isNotEmpty()) return matches
    }
    return listOfNotNull(rootInActiveWindow)
  }

  private fun availableA11yDisplays(): List<Int> {
    if (Build.VERSION.SDK_INT < 30) return listOf(0)
    val all = windowsOnAllDisplays
    val ids = mutableListOf<Int>()
    for (i in 0 until all.size()) ids.add(all.keyAt(i))
    return ids
  }

  private fun snapshot(
    payload: JSONObject,
    success: (JSONObject) -> Unit,
    failure: (String) -> Unit
  ) {
    val displayId = payload.optInt("displayId", -1)
    val roots = rootsForDisplay(displayId)
    if (roots.isEmpty()) {
      val visible = availableA11yDisplays().joinToString(",")
      failure(
        "No accessibility content is available on display $displayId. On stock Android a " +
          "non-system accessibility service is only granted windows on displays it can observe " +
          "(currently: [$visible]); reading a secondary/off-screen display reliably needs a " +
          "system-signed build. Use displayId from phone_displays and omit it to read the active screen."
      )
      return
    }
    val maxNodes = payload.optInt("maxNodes", 250).coerceIn(1, 500)
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

    roots.forEachIndexed { rootIndex, root -> visit(root, "$rootIndex") }
    val primary = roots.first()
    val windowsJson = JSONArray()
    windows.forEach { window ->
      windowsJson.put(JSONObject().apply {
        put("id", window.id)
        put("type", window.type)
        put("displayId", if (Build.VERSION.SDK_INT >= 30) window.displayId else 0)
        put("title", window.title?.toString() ?: JSONObject.NULL)
        put("active", window.isActive)
        put("focused", window.isFocused)
      })
    }
    success(JSONObject().apply {
      put("displayId", displayId)
      put("packageName", primary.packageName?.toString() ?: JSONObject.NULL)
      put("className", primary.className?.toString() ?: JSONObject.NULL)
      put("nodes", nodes)
      put("windows", windowsJson)
      put("nodeCount", count)
      put("truncated", count >= maxNodes)
      put("availableDisplays", JSONArray(availableA11yDisplays()))
    })
  }

  private fun tap(
    payload: JSONObject,
    success: (JSONObject) -> Unit,
    failure: (String) -> Unit
  ) {
    val displayId = payload.optInt("displayId", -1)
    val text = payload.optString("text").takeIf { it.isNotBlank() }
    val viewId = payload.optString("viewId").takeIf { it.isNotBlank() }
    if (text != null || viewId != null) {
      val target = findNode(text, viewId, displayId)
      if (target == null) {
        failure("No accessibility node matched the requested text or view id on display $displayId.")
        return
      }
      val onDefaultDisplay = displayId < 0 || displayId == Display.DEFAULT_DISPLAY
      // On the active display, a real coordinate gesture at the node center is
      // the most reliable way to actually trigger navigation: ACTION_CLICK on a
      // list row often "succeeds" without the app reacting. Off-screen displays
      // can't receive coordinate gestures, so use the semantic click there.
      if (onDefaultDisplay) {
        val bounds = Rect()
        target.getBoundsInScreen(bounds)
        if (!bounds.isEmpty) {
          dispatchTap(bounds.exactCenterX(), bounds.exactCenterY(), 80, success, failure)
          return
        }
      }
      var clickable: AccessibilityNodeInfo? = target
      while (clickable != null && !clickable.isClickable) {
        clickable = clickable.parent
      }
      if (clickable?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true) {
        success(JSONObject().put("dispatched", true).put("method", "accessibility_click"))
        return
      }
      failure("Matched a node on display $displayId but could not tap it (no on-screen bounds and no clickable ancestor).")
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
      payload.optString("viewId").takeIf { it.isNotBlank() },
      payload.optInt("displayId", -1)
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
    payload: JSONObject,
    success: (JSONObject) -> Unit,
    failure: (String) -> Unit
  ) {
    if (Build.VERSION.SDK_INT < 30) {
      failure("Accessibility screenshots require Android 11 or newer.")
      return
    }
    val requestedQuality = payload.optInt("quality", 72)
    val targetDisplay = payload.optInt("displayId", -1).let {
      if (it < 0) Display.DEFAULT_DISPLAY else it
    }
    takeScreenshot(
      targetDisplay,
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

  private fun findNode(
    text: String?,
    viewId: String?,
    displayId: Int = -1
  ): AccessibilityNodeInfo? {
    for (root in rootsForDisplay(displayId)) {
      if (viewId != null) {
        root.findAccessibilityNodeInfosByViewId(viewId).firstOrNull()?.let { return it }
      }
      if (text != null) {
        root.findAccessibilityNodeInfosByText(text).firstOrNull()?.let { return it }
      }
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

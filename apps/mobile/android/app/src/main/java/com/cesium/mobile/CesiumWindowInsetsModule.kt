package com.cesium.mobile

import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import kotlin.math.ceil
import kotlin.math.max

class CesiumWindowInsetsModule(
  private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "CesiumWindowInsets"

  @ReactMethod
  fun getInsets(promise: Promise) {
    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.resolve(insetsMap(0, 0))
      return
    }

    activity.runOnUiThread {
      val decorView = activity.window.decorView
      val rootInsets = ViewCompat.getRootWindowInsets(decorView)
      val statusBarInsets =
        rootInsets?.getInsets(WindowInsetsCompat.Type.statusBars()) ?: Insets.NONE
      val cutoutTopPx = rootInsets?.displayCutout?.safeInsetTop ?: 0
      val density = decorView.resources.displayMetrics.density.takeIf { it > 0f } ?: 1f
      val statusBarTop = toDp(statusBarInsets.top, density)
      val displayCutoutTop = toDp(cutoutTopPx, density)
      promise.resolve(insetsMap(statusBarTop, displayCutoutTop))
    }
  }

  private fun insetsMap(statusBarTop: Int, displayCutoutTop: Int) =
    Arguments.createMap().apply {
      putInt("statusBarTop", statusBarTop)
      putInt("displayCutoutTop", displayCutoutTop)
      putInt("safeAreaTop", max(statusBarTop, displayCutoutTop))
    }

  private fun toDp(px: Int, density: Float): Int =
    if (px <= 0) 0 else ceil(px / density.toDouble()).toInt()
}

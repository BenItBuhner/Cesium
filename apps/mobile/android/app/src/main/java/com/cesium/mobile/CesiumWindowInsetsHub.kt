package com.cesium.mobile

import android.view.View
import androidx.core.view.WindowInsetsCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import kotlin.math.ceil
import kotlin.math.max

/**
 * Connects window-inset dispatch to the React bridge, mirroring
 * [CesiumPredictiveBackHub]:
 *
 * - The activity's content-view inset listener ([CesiumImeInsets]) calls
 *   [report] on every static inset pass, so the top inset is event-driven
 *   rather than polled. This is what keeps the web chrome aligned after the
 *   app is backgrounded and refocused: polling at resume can race the window
 *   re-attach and observe no insets at all, but the re-attach itself always
 *   ends in an inset dispatch that lands here.
 * - [CesiumWindowInsetsModule] installs [emitter] and forwards changes to JS
 *   as `cesiumWindowInsetsChanged` device events.
 *
 * Both sides can appear/disappear independently (React instance reloads,
 * activity recreation), so they rendezvous through this process-wide object.
 */
object CesiumWindowInsetsHub {
  const val EVENT_NAME = "cesiumWindowInsetsChanged"

  /** Installed by the React module; forwards inset snapshots to JS. */
  @Volatile var emitter: ((payload: WritableMap) -> Unit)? = null

  @Volatile private var lastStatusBarTop = -1
  @Volatile private var lastDisplayCutoutTop = -1

  fun report(view: View, insets: WindowInsetsCompat) {
    val statusBarTopPx = insets.getInsets(WindowInsetsCompat.Type.statusBars()).top
    val cutoutTopPx = insets.displayCutout?.safeInsetTop ?: 0
    val density = view.resources.displayMetrics.density.takeIf { it > 0f } ?: 1f
    val statusBarTop = toDp(statusBarTopPx, density)
    val displayCutoutTop = toDp(cutoutTopPx, density)
    if (statusBarTop == lastStatusBarTop && displayCutoutTop == lastDisplayCutoutTop) {
      return
    }
    lastStatusBarTop = statusBarTop
    lastDisplayCutoutTop = displayCutoutTop
    emitter?.invoke(insetsMap(statusBarTop, displayCutoutTop))
  }

  /**
   * A fresh React instance starts with no inset state, so the next dispatch
   * must reach it even when the values did not change since the last emit.
   */
  fun resetDedupe() {
    lastStatusBarTop = -1
    lastDisplayCutoutTop = -1
  }

  fun insetsMap(statusBarTop: Int, displayCutoutTop: Int): WritableMap =
    Arguments.createMap().apply {
      putInt("statusBarTop", statusBarTop)
      putInt("displayCutoutTop", displayCutoutTop)
      putInt("safeAreaTop", max(statusBarTop, displayCutoutTop))
    }

  fun toDp(px: Int, density: Float): Int =
    if (px <= 0) 0 else ceil(px / density.toDouble()).toInt()
}

package com.cesium.mobile

import android.app.Activity
import android.view.View
import androidx.core.view.OnApplyWindowInsetsListener
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Window-level IME (soft keyboard) inset handling.
 *
 * The manifest asks for `adjustResize`, but React Native force-enables
 * edge-to-edge whenever the app targets SDK 35+ (`WindowUtil.enableEdgeToEdge`
 * calls `setDecorFitsSystemWindows(false)` on every device). Once the decor no
 * longer fits system windows, the framework never resizes the window for the
 * keyboard; instead it falls back to panning the whole window upward, which
 * shoves the top of the WebView (and the workbench toolbar) off-screen.
 *
 * Per the Android edge-to-edge guidance, the app must consume
 * [WindowInsetsCompat.Type.ime] itself. This pads the activity content view by
 * the keyboard height so the React root — and therefore the WebView — shrinks
 * to the visible area, letting the web layout reflow instead of being cut off.
 * Because every text field in the app lives inside the single WebView, this
 * one hook fixes keyboard occlusion everywhere at once.
 */
internal object CesiumImeInsets {
  fun install(activity: Activity) {
    val content = activity.findViewById<View>(android.R.id.content) ?: return
    val callback = ImeInsetsCallback(content)
    ViewCompat.setOnApplyWindowInsetsListener(content, callback)
    ViewCompat.setWindowInsetsAnimationCallback(content, callback)
  }
}

/**
 * The "deferred insets" pattern from the platform IME-animation docs: static
 * inset dispatch applies the end-state padding immediately, so while an IME
 * animation is running the static pass is skipped and [onProgress] drives the
 * padding frame-by-frame instead. This keeps the WebView edge glued to the top
 * of the keyboard as it slides, rather than jumping ahead of it.
 */
private class ImeInsetsCallback(
  private val view: View
) : WindowInsetsAnimationCompat.Callback(DISPATCH_MODE_CONTINUE_ON_SUBTREE),
  OnApplyWindowInsetsListener {

  private var deferStaticApply = false
  private var lastInsets: WindowInsetsCompat? = null

  override fun onApplyWindowInsets(v: View, insets: WindowInsetsCompat): WindowInsetsCompat {
    lastInsets = insets
    // Every static pass also feeds the top-inset bridge: this is the
    // event-driven source that keeps the WebView's safe-area CSS variable
    // correct across background/refocus cycles (see CesiumWindowInsetsHub).
    CesiumWindowInsetsHub.report(v, insets)
    if (!deferStaticApply) {
      applyImePadding(insets)
    }
    // Not consumed: children still need the other inset types (RN reads the
    // status bar / cutout insets for pointer-event offsets).
    return insets
  }

  override fun onPrepare(animation: WindowInsetsAnimationCompat) {
    if (animation.typeMask and WindowInsetsCompat.Type.ime() != 0) {
      deferStaticApply = true
    }
  }

  override fun onProgress(
    insets: WindowInsetsCompat,
    runningAnimations: List<WindowInsetsAnimationCompat>
  ): WindowInsetsCompat {
    if (runningAnimations.any { (it.typeMask and WindowInsetsCompat.Type.ime()) != 0 }) {
      applyImePadding(insets)
    }
    return insets
  }

  override fun onEnd(animation: WindowInsetsAnimationCompat) {
    if (animation.typeMask and WindowInsetsCompat.Type.ime() != 0) {
      deferStaticApply = false
      // Settle on the authoritative end state (covers cancelled gestures on
      // devices that drive the IME interactively).
      lastInsets?.let { applyImePadding(it) }
    }
  }

  private fun applyImePadding(insets: WindowInsetsCompat) {
    val imeBottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
    if (view.paddingBottom != imeBottom) {
      view.setPadding(view.paddingLeft, view.paddingTop, view.paddingRight, imeBottom)
    }
  }
}

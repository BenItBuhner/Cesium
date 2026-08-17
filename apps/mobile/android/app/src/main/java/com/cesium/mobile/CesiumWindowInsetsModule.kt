package com.cesium.mobile

import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * React Native bridge for the top window insets (status bar / display cutout).
 *
 * Two delivery paths, both in dp:
 *
 * - Pull: [getInsets] snapshots the current root window insets. When they are
 *   unreadable — no current activity, or the decor view has no dispatched
 *   insets yet, both of which happen transiently while the app is being
 *   refocused — the promise *rejects* instead of resolving zeros. Resolving
 *   zeros used to overwrite the workbench's known-good safe area and shove the
 *   entire top chrome under the status bar until the process was killed.
 * - Push: [CesiumWindowInsetsHub] emits `cesiumWindowInsetsChanged` device
 *   events from the content view's inset dispatch (see [CesiumImeInsets]), so
 *   JS converges on the real value even when every pull raced the re-attach.
 */
class CesiumWindowInsetsModule(
  private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext), LifecycleEventListener {
  override fun getName(): String = "CesiumWindowInsets"

  override fun initialize() {
    super.initialize()
    reactContext.addLifecycleEventListener(this)
    CesiumWindowInsetsHub.resetDedupe()
    CesiumWindowInsetsHub.emitter = { payload ->
      if (reactContext.hasActiveReactInstance()) {
        reactContext
          .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit(CesiumWindowInsetsHub.EVENT_NAME, payload)
      }
    }
  }

  override fun invalidate() {
    CesiumWindowInsetsHub.emitter = null
    reactContext.removeLifecycleEventListener(this)
    super.invalidate()
  }

  @ReactMethod
  fun getInsets(promise: Promise) {
    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.reject("E_NO_ACTIVITY", "Window insets unavailable: no current activity.")
      return
    }

    activity.runOnUiThread {
      val decorView = activity.window.decorView
      val rootInsets = ViewCompat.getRootWindowInsets(decorView)
      if (rootInsets == null) {
        promise.reject(
          "E_NO_INSETS",
          "Window insets unavailable: decor view has no dispatched insets yet."
        )
        return@runOnUiThread
      }
      CesiumWindowInsetsHub.report(decorView, rootInsets)
      val statusBarTopPx = rootInsets.getInsets(WindowInsetsCompat.Type.statusBars()).top
      val cutoutTopPx = rootInsets.displayCutout?.safeInsetTop ?: 0
      val density = decorView.resources.displayMetrics.density.takeIf { it > 0f } ?: 1f
      promise.resolve(
        CesiumWindowInsetsHub.insetsMap(
          CesiumWindowInsetsHub.toDp(statusBarTopPx, density),
          CesiumWindowInsetsHub.toDp(cutoutTopPx, density)
        )
      )
    }
  }

  override fun onHostResume() {
    // Force a fresh inset pass on the content view so the hub re-reports even
    // when the system decides nothing needs re-dispatching after resume.
    val activity = reactContext.currentActivity ?: return
    activity.runOnUiThread {
      activity.findViewById<View>(android.R.id.content)?.let {
        ViewCompat.requestApplyInsets(it)
      }
    }
  }

  override fun onHostPause() = Unit

  override fun onHostDestroy() = Unit
}

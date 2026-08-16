package com.cesium.mobile

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * React Native bridge for Android's progressive (predictive) back gesture.
 *
 * JS arms/disarms the in-app back interception with [setBackInterceptEnabled];
 * while armed, [MainActivity]'s `OnBackPressedCallback` sits on top of React
 * Native's own plain callback in the `OnBackPressedDispatcher` and streams the
 * gesture to JS as device events:
 *
 * - `cesiumBackStarted`    { progress, swipeEdge, touchX, touchY }
 * - `cesiumBackProgressed` { progress, swipeEdge, touchX, touchY }
 * - `cesiumBackCancelled`
 * - `cesiumBackInvoked`    (the gesture committed; JS routes the intent)
 *
 * While disarmed, back flows through React Native's classic path
 * (`hardwareBackPress`) or the system default, exactly as before.
 */
class CesiumPredictiveBackModule(
  private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "CesiumPredictiveBack"

  override fun initialize() {
    super.initialize()
    CesiumPredictiveBackHub.emitter = { name, payload ->
      if (reactContext.hasActiveReactInstance()) {
        reactContext
          .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit(name, payload)
      }
    }
  }

  override fun invalidate() {
    CesiumPredictiveBackHub.emitter = null
    // A dead React instance can no longer route an intercepted gesture, so
    // hand back to the system/legacy path until a fresh instance re-arms.
    CesiumPredictiveBackHub.setInterceptEnabled(false)
    super.invalidate()
  }

  @ReactMethod
  fun setBackInterceptEnabled(enabled: Boolean) {
    CesiumPredictiveBackHub.setInterceptEnabled(enabled)
  }
}

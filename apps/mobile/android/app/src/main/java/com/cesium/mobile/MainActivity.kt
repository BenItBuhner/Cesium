package com.cesium.mobile

import android.content.Intent
import android.os.Bundle
import androidx.activity.BackEventCompat
import androidx.activity.OnBackPressedCallback
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {
  /**
   * Progressive predictive-back interception.
   *
   * React Native's own `OnBackPressedCallback` (registered by [ReactActivity]
   * on Android 16+) is a plain callback: it only fires at gesture commit, so
   * the gradual back-gesture stream Android delivers on API 34+ never reaches
   * the app and nothing can track the user's finger. This callback overrides
   * the progressive members and forwards the whole stream to JS, which drives
   * the in-WebView layer animations (drawers, settings view) frame by frame.
   *
   * It is registered *after* `super.onCreate` (which registers React Native's
   * callback), so the dispatcher's LIFO ordering puts it on top whenever it is
   * enabled. JS keeps `isEnabled` mirrored to "the app has something to pop"
   * (an in-WebView layer or WebView history) via [CesiumPredictiveBackHub];
   * while disabled, back falls through to React Native's classic path or the
   * system's own predictive back-to-home animation.
   */
  private val predictiveBackCallback = object : OnBackPressedCallback(false) {
    override fun handleOnBackStarted(backEvent: BackEventCompat) {
      CesiumPredictiveBackHub.emit("cesiumBackStarted", gesturePayload(backEvent))
    }

    override fun handleOnBackProgressed(backEvent: BackEventCompat) {
      CesiumPredictiveBackHub.emit("cesiumBackProgressed", gesturePayload(backEvent))
    }

    override fun handleOnBackCancelled() {
      CesiumPredictiveBackHub.emit("cesiumBackCancelled", null)
    }

    override fun handleOnBackPressed() {
      // Disarm until JS re-confirms it still has something to pop. This makes
      // an exit loop structurally impossible: if JS decides to leave the app,
      // the resulting `super.onBackPressed()` walk of the dispatcher can never
      // re-enter this callback. JS re-arms via `backCapability` after each pop.
      CesiumPredictiveBackHub.setInterceptEnabled(false)
      CesiumPredictiveBackHub.emit("cesiumBackInvoked", null)
    }
  }

  private val predictiveBackEnabledSink: (Boolean) -> Unit = { enabled ->
    runOnUiThread { predictiveBackCallback.isEnabled = enabled }
  }

  override fun getMainComponentName(): String = "CesiumMobile"

  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
    handleNotificationIntent(intent)
    CesiumPredictiveBackHub.enabledSink = predictiveBackEnabledSink
    predictiveBackCallback.isEnabled = CesiumPredictiveBackHub.isInterceptEnabled()
    onBackPressedDispatcher.addCallback(this, predictiveBackCallback)
  }

  override fun onDestroy() {
    // Only clear the hub when the sink still belongs to this instance; a
    // recreated activity may already have installed its own.
    if (CesiumPredictiveBackHub.enabledSink === predictiveBackEnabledSink) {
      CesiumPredictiveBackHub.enabledSink = null
    }
    super.onDestroy()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleNotificationIntent(intent)
  }

  private fun handleNotificationIntent(intent: Intent?) {
    CesiumNotificationIntentStore.update(intent)
  }

  private fun gesturePayload(backEvent: BackEventCompat): WritableMap =
    Arguments.createMap().apply {
      putDouble("progress", backEvent.progress.toDouble())
      putInt("swipeEdge", backEvent.swipeEdge)
      putDouble("touchX", backEvent.touchX.toDouble())
      putDouble("touchY", backEvent.touchY.toDouble())
    }
}

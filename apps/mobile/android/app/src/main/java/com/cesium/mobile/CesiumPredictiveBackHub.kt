package com.cesium.mobile

import com.facebook.react.bridge.WritableMap

/**
 * Connects the predictive-back plumbing that lives in two different worlds:
 *
 * - [MainActivity] owns the androidx `OnBackPressedCallback` that receives the
 *   system's progressive back-gesture stream (started / progressed /
 *   cancelled / pressed) and observes [enabledSink] so the callback's
 *   `isEnabled` state always mirrors what the JS layer last requested.
 * - [CesiumPredictiveBackModule] owns the React Native bridge: it publishes
 *   the JS-requested intercept state via [setInterceptEnabled] and installs
 *   [emitter] so gesture events reach JS as device events.
 *
 * Both sides can appear/disappear independently (React instance reloads,
 * activity recreation), so they rendezvous through this process-wide object
 * instead of holding direct references to each other.
 */
object CesiumPredictiveBackHub {
  /** Installed by the React module; forwards gesture events to JS. */
  @Volatile var emitter: ((name: String, payload: WritableMap?) -> Unit)? = null

  /** Installed by the activity; invoked whenever the intercept state changes. */
  @Volatile var enabledSink: ((enabled: Boolean) -> Unit)? = null

  @Volatile private var interceptEnabled = false

  fun setInterceptEnabled(enabled: Boolean) {
    interceptEnabled = enabled
    enabledSink?.invoke(enabled)
  }

  fun isInterceptEnabled(): Boolean = interceptEnabled

  fun emit(name: String, payload: WritableMap?) {
    emitter?.invoke(name, payload)
  }
}

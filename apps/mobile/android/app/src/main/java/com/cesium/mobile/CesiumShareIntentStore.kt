package com.cesium.mobile

import android.content.Intent

/**
 * Holds the most recent ACTION_SEND / ACTION_SEND_MULTIPLE intent delivered to
 * MainActivity until the React Native layer consumes it (mirrors
 * CesiumNotificationIntentStore). Share intents arrive before the JS bridge is
 * ready on cold starts, so they must be parked here rather than pushed.
 */
object CesiumShareIntentStore {
  @Volatile
  private var lastIntent: Intent? = null

  fun update(intent: Intent?) {
    val action = intent?.action
    if (action == Intent.ACTION_SEND || action == Intent.ACTION_SEND_MULTIPLE) {
      lastIntent = intent
    }
  }

  fun consume(): Intent? {
    val value = lastIntent
    lastIntent = null
    return value
  }
}

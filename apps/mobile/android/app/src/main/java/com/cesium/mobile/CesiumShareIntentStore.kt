package com.cesium.mobile

import android.content.Intent

/**
 * Holds the most recent ACTION_SEND / ACTION_SEND_MULTIPLE intent until the
 * JS layer consumes it, mirroring [CesiumNotificationIntentStore]. The share
 * sheet may deliver the intent before React has booted (cold start) or while
 * the app is already running (onNewIntent) — either way the payload waits
 * here until `consumeSharedPayload` drains it.
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

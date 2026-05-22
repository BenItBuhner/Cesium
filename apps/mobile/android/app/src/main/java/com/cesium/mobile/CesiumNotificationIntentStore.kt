package com.cesium.mobile

import android.content.Intent

object CesiumNotificationIntentStore {
  @Volatile
  private var lastIntent: Intent? = null

  fun update(intent: Intent?) {
    if (intent?.getStringExtra("cesiumAction") != null) {
      lastIntent = intent
    }
  }

  fun consume(): Intent? {
    val value = lastIntent
    lastIntent = null
    return value
  }
}

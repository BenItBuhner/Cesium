package com.cesium.mobile.background

import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.bridge.Arguments

class CesiumHeadlessService : HeadlessJsTaskService() {
  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
    val data = Arguments.createMap()
    data.putString("reason", intent?.getStringExtra("reason") ?: "background-sync")
    return HeadlessJsTaskConfig(
      "CesiumBackgroundSync",
      data,
      30000,
      false
    )
  }
}

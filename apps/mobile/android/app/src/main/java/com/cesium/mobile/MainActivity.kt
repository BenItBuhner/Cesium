package com.cesium.mobile

import android.content.Intent
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {
  override fun getMainComponentName(): String = "CesiumMobile"

  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
    handleLaunchIntent(intent)
  }

  override fun onNewIntent(intent: Intent) {
    // Update the intent stores first: super.onNewIntent() notifies React's
    // ActivityEventListeners (CesiumAndroidRuntimeModule nudges JS to drain
    // the share store), so the payload must already be staged by then.
    handleLaunchIntent(intent)
    super.onNewIntent(intent)
    setIntent(intent)
  }

  private fun handleLaunchIntent(intent: Intent?) {
    CesiumNotificationIntentStore.update(intent)
    CesiumShareIntentStore.update(intent)
  }
}

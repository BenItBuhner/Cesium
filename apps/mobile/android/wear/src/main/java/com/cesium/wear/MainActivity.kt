package com.cesium.wear

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.cesium.wear.data.WatchStateStore
import com.cesium.wear.sync.PhoneCompanionActionClient
import com.cesium.wear.sync.WearDataLayerRepository
import com.cesium.wear.ui.CesiumWearApp

class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val stateStore = WatchStateStore(this)
    val dataLayerRepository = WearDataLayerRepository(this, stateStore)
    val actionClient = PhoneCompanionActionClient(this)
    setContent {
      CesiumWearApp(
        stateStore = stateStore,
        dataLayerRepository = dataLayerRepository,
        actionClient = actionClient
      )
    }
  }
}

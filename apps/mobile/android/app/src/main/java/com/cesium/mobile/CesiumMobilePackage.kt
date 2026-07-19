package com.cesium.mobile

import com.cesium.mobile.wear.CesiumWearCompanionModule
import com.cesium.mobile.notifications.CesiumLiveUpdatesModule
import com.cesium.mobile.phonecontrol.CesiumPhoneControlModule
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class CesiumMobilePackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
    return listOf(
      CesiumAndroidRuntimeModule(reactContext),
      CesiumLiveUpdatesModule(reactContext),
      CesiumWearCompanionModule(reactContext),
      CesiumPhoneControlModule(reactContext),
      CesiumWindowInsetsModule(reactContext)
    )
  }

  override fun createViewManagers(
    reactContext: ReactApplicationContext
  ): List<ViewManager<*, *>> = emptyList()
}

package com.cesium.mobile.phonecontrol

import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.cesium.mobile.assistant.CesiumVoiceInteractionService
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class CesiumPhoneControlModule(
  private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "CesiumPhoneControl"

  @ReactMethod
  fun setEnabled(
    enabled: Boolean,
    serverUrl: String,
    workspaceId: String,
    authToken: String?,
    promise: Promise
  ) {
    if (enabled && (serverUrl.isBlank() || workspaceId.isBlank())) {
      promise.reject("MOBILE_CONTROL_CONFIG", "Select a Cesium server and workspace first.")
      return
    }
    MobileControlPreferences.updateConnection(
      reactContext,
      serverUrl,
      workspaceId,
      authToken
    )
    MobileControlPreferences.setEnabled(reactContext, enabled)
    val intent = Intent(reactContext, CesiumMobileControlService::class.java)
      .setAction(
        if (enabled) CesiumMobileControlService.ACTION_START
        else CesiumMobileControlService.ACTION_DISABLE
      )
    try {
      if (enabled) ContextCompat.startForegroundService(reactContext, intent)
      else reactContext.startService(intent)
      promise.resolve(statusMap())
    } catch (error: Throwable) {
      MobileControlPreferences.setEnabled(reactContext, false)
      promise.reject("MOBILE_CONTROL_SERVICE", error.message, error)
    }
  }

  @ReactMethod
  fun syncConnection(
    serverUrl: String,
    workspaceId: String,
    authToken: String?,
    promise: Promise
  ) {
    val config = MobileControlPreferences.updateConnection(
      reactContext,
      serverUrl,
      workspaceId,
      authToken
    )
    if (config.enabled && serverUrl.isNotBlank() && workspaceId.isNotBlank()) {
      try {
        ContextCompat.startForegroundService(
          reactContext,
          Intent(reactContext, CesiumMobileControlService::class.java)
            .setAction(CesiumMobileControlService.ACTION_START)
        )
      } catch (_: Throwable) {
        // Status reports the connection failure; syncing app state stays best-effort.
      }
    }
    promise.resolve(statusMap())
  }

  @ReactMethod
  fun getStatus(promise: Promise) {
    promise.resolve(statusMap())
  }

  @ReactMethod
  fun openAccessibilitySettings(promise: Promise) {
    promise.resolve(openSettings(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)))
  }

  @ReactMethod
  fun requestAssistantRole(promise: Promise) {
    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.resolve(false)
      return
    }
    try {
      val intent =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          val manager = reactContext.getSystemService(RoleManager::class.java)
          if (manager.isRoleAvailable(RoleManager.ROLE_ASSISTANT)) {
            manager.createRequestRoleIntent(RoleManager.ROLE_ASSISTANT)
          } else {
            Intent(Settings.ACTION_VOICE_INPUT_SETTINGS)
          }
        } else {
          Intent(Settings.ACTION_VOICE_INPUT_SETTINGS)
        }
      activity.startActivity(intent)
      promise.resolve(true)
    } catch (error: Throwable) {
      promise.reject("ASSISTANT_ROLE", error.message, error)
    }
  }

  @ReactMethod
  fun launchAssistant(promise: Promise) {
    promise.resolve(
      if (CesiumVoiceInteractionService.show()) true
      else openSettings(Intent(Intent.ACTION_ASSIST))
    )
  }

  private fun openSettings(intent: Intent): Boolean {
    if (intent.resolveActivity(reactContext.packageManager) == null) return false
    val activity = reactContext.currentActivity
    if (activity != null) {
      activity.startActivity(intent)
    } else {
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      reactContext.startActivity(intent)
    }
    return true
  }

  private fun statusMap() = Arguments.createMap().apply {
    val status = CesiumMobileControlService.status(reactContext)
    putBoolean("enabled", status.optBoolean("enabled"))
    putString("connectionState", status.optString("connectionState", "disabled"))
    putString("lastError", status.optString("lastError").takeIf { it.isNotBlank() })
    putString("serverUrl", status.optString("serverUrl"))
    putString("workspaceId", status.optString("workspaceId"))
    putString("deviceId", status.optString("deviceId"))
    putBoolean("accessibilityEnabled", status.optBoolean("accessibilityEnabled"))
    putBoolean("assistantSelected", status.optBoolean("assistantSelected"))
    putBoolean("assistantRoleAvailable", status.optBoolean("assistantRoleAvailable"))
    putString("hotwordMode", status.optString("hotwordMode"))
    putBoolean("privateDisplaySupported", status.optBoolean("privateDisplaySupported"))
  }

  companion object {
    fun isAssistantRoleAvailable(context: Context): Boolean {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return true
      return context.getSystemService(RoleManager::class.java)
        .isRoleAvailable(RoleManager.ROLE_ASSISTANT)
    }

    fun isAssistantSelected(context: Context): Boolean {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val manager = context.getSystemService(RoleManager::class.java)
        return manager.isRoleAvailable(RoleManager.ROLE_ASSISTANT) &&
          manager.isRoleHeld(RoleManager.ROLE_ASSISTANT)
      }
      return Settings.Secure.getString(
        context.contentResolver,
        "voice_interaction_service"
      )?.contains(context.packageName) == true
    }
  }
}

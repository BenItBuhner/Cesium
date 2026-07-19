package com.cesium.mobile.phonecontrol

import android.app.role.RoleManager
import android.content.Intent
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import org.json.JSONObject

class CesiumPhoneControlModule(
  private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "CesiumPhoneControl"

  @ReactMethod
  fun getStatus(promise: Promise) {
    try {
      promise.resolve(statusJson().toString())
    } catch (error: Exception) {
      promise.reject("CESIUM_PHONE_STATUS_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun configure(json: String, promise: Promise) {
    try {
      val config = PhoneControlPreferences.update(reactContext, json)
      if (config.configured) {
        CesiumPhoneControlService.start(reactContext)
      } else {
        CesiumPhoneControlService.stop(reactContext)
      }
      promise.resolve(statusJson().toString())
    } catch (error: Exception) {
      promise.reject("CESIUM_PHONE_CONFIG_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun setEnabled(enabled: Boolean, promise: Promise) {
    try {
      val config = PhoneControlPreferences.setEnabled(reactContext, enabled)
      if (config.configured) {
        CesiumPhoneControlService.start(reactContext)
      } else {
        CesiumPhoneControlService.stop(reactContext)
      }
      promise.resolve(statusJson().toString())
    } catch (error: Exception) {
      promise.reject("CESIUM_PHONE_ENABLE_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun openAccessibilitySettings(promise: Promise) {
    openSettings(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS), promise)
  }

  @ReactMethod
  fun requestAssistantRole(promise: Promise) {
    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.reject("CESIUM_NO_ACTIVITY", "No Android activity is available.")
      return
    }
    try {
      if (Build.VERSION.SDK_INT >= 29) {
        val manager = activity.getSystemService(RoleManager::class.java)
        activity.startActivity(manager.createRequestRoleIntent(RoleManager.ROLE_ASSISTANT))
      } else {
        activity.startActivity(Intent(Settings.ACTION_VOICE_INPUT_SETTINGS))
      }
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("CESIUM_ASSISTANT_ROLE_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun openAssistantSettings(promise: Promise) {
    openSettings(Intent(Settings.ACTION_VOICE_INPUT_SETTINGS), promise)
  }

  @ReactMethod
  fun invokeAssistant(promise: Promise) {
    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.reject("CESIUM_NO_ACTIVITY", "No Android activity is available.")
      return
    }
    try {
      activity.startActivity(Intent(Intent.ACTION_ASSIST))
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("CESIUM_ASSISTANT_INVOKE_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun executeCommand(json: String, promise: Promise) {
    try {
      PhoneCommandExecutor.execute(
        reactContext,
        JSONObject(json),
        success = { result -> promise.resolve(result.toString()) },
        failure = { message -> promise.reject("CESIUM_PHONE_COMMAND_FAILED", message) }
      )
    } catch (error: Exception) {
      promise.reject("CESIUM_PHONE_COMMAND_FAILED", error.message, error)
    }
  }

  private fun openSettings(intent: Intent, promise: Promise) {
    try {
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      reactContext.startActivity(intent)
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("CESIUM_PHONE_SETTINGS_FAILED", error.message, error)
    }
  }

  private fun statusJson(): JSONObject {
    val config = PhoneControlPreferences.read(reactContext)
    return PhoneCommandExecutor.status(reactContext).apply {
      put("configured", config.serverUrl.isNotBlank() && config.workspaceId.isNotBlank())
      put("serverUrl", config.serverUrl)
      put("workspaceId", config.workspaceId)
    }
  }
}

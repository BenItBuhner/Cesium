package com.cesium.mobile.phonecontrol

import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import org.json.JSONArray
import org.json.JSONObject

object PhoneCommandExecutor {
  private val mainHandler = Handler(Looper.getMainLooper())

  fun capabilities(context: Context): JSONObject {
    val accessibility = CesiumAccessibilityService.instance != null
    val assistantHeld = if (Build.VERSION.SDK_INT >= 29) {
      context.getSystemService(RoleManager::class.java)
        .isRoleHeld(RoleManager.ROLE_ASSISTANT)
    } else {
      false
    }
    return JSONObject().apply {
      put("appLaunch", accessibility)
      put("appList", true)
      put("screenSnapshot", accessibility)
      put("screenCapture", accessibility && Build.VERSION.SDK_INT >= 30)
      put("gestures", accessibility)
      put("textInput", accessibility)
      put("globalActions", accessibility)
      put("settings", accessibility)
      put("secondaryDisplay", accessibility)
      put("assistant", true)
      put("accessibilityEnabled", CesiumAccessibilityService.isEnabled(context))
      put("assistantRoleHeld", assistantHeld)
      put("thirdPartyAppsOnSecondaryDisplay", false)
      put("hardwareWakeWord", false)
    }
  }

  fun status(context: Context): JSONObject = JSONObject().apply {
    put("deviceId", PhoneControlPreferences.deviceId(context))
    put("capabilities", capabilities(context))
    put("secondaryDisplay", CesiumSecondaryDisplayController.status())
    put("controlEnabled", PhoneControlPreferences.read(context).enabled)
    put("platform", "android")
    put(
      "wakeWord",
      JSONObject().apply {
        put("supported", false)
        put("reason", "True always-on DSP hotword access requires OEM signature permissions.")
      }
    )
  }

  fun execute(
    context: Context,
    payload: JSONObject,
    success: (JSONObject) -> Unit,
    failure: (String) -> Unit
  ) {
    mainHandler.post {
      try {
        when (payload.optString("type")) {
          "get_status" -> success(status(context))
          "list_apps" -> success(listApps(context, payload.optString("query")))
          "list_displays" -> success(
            JSONObject().put("displays", CesiumSecondaryDisplayController.listDisplays(context))
          )
          "launch_app" -> success(launchApp(context, payload))
          "open_settings" -> success(openSettings(context, payload))
          "secondary_display" -> success(
            CesiumSecondaryDisplayController.execute(
              CesiumAccessibilityService.instance ?: context,
              payload
            )
          )
          "snapshot",
          "screenshot",
          "tap",
          "long_press",
          "swipe",
          "type_text",
          "global_action" -> {
            val service = CesiumAccessibilityService.instance
            if (service == null) {
              failure("Cesium accessibility control is not connected. Enable it in Android Accessibility settings.")
            } else {
              service.execute(payload, success, failure)
            }
          }
          else -> failure("Unsupported phone command type.")
        }
      } catch (error: Exception) {
        failure(error.message ?: "Phone command failed.")
      }
    }
  }

  private fun listApps(context: Context, query: String): JSONObject {
    val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
    val normalized = query.trim().lowercase()
    val entries = context.packageManager
      .queryIntentActivities(intent, 0)
      .map { info ->
        JSONObject().apply {
          put("label", info.loadLabel(context.packageManager).toString())
          put("packageName", info.activityInfo.packageName)
          put("activityName", info.activityInfo.name)
        }
      }
      .filter { entry ->
        normalized.isBlank() ||
          entry.optString("label").lowercase().contains(normalized) ||
          entry.optString("packageName").lowercase().contains(normalized)
      }
      .distinctBy { it.optString("packageName") }
      .sortedBy { it.optString("label").lowercase() }
      .take(500)
    return JSONObject().put("apps", JSONArray(entries)).put("count", entries.size)
  }

  private fun launchApp(context: Context, payload: JSONObject): JSONObject {
    val deepLink = payload.optString("deepLink").takeIf { it.isNotBlank() }
    val packageName = payload.optString("packageName").takeIf { it.isNotBlank() }
    val appName = payload.optString("appName").takeIf { it.isNotBlank() }
    val intent = if (deepLink != null) {
      val uri = Uri.parse(deepLink)
      val scheme = uri.scheme?.lowercase()
      if (scheme.isNullOrBlank() || scheme in setOf("javascript", "file", "content")) {
        throw IllegalArgumentException("Unsafe or invalid deep-link scheme.")
      }
      Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)
    } else {
      val resolvedPackage = packageName ?: findPackageByLabel(context, appName!!)
        ?: throw IllegalArgumentException("No launchable app matched '$appName'.")
      context.packageManager.getLaunchIntentForPackage(resolvedPackage)
        ?: throw IllegalArgumentException("Package '$resolvedPackage' has no launchable activity.")
    }
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    (CesiumAccessibilityService.instance ?: context).startActivity(intent)
    return JSONObject().apply {
      put("launched", true)
      put("packageName", intent.`package` ?: packageName ?: JSONObject.NULL)
      put("deepLink", deepLink ?: JSONObject.NULL)
    }
  }

  private fun findPackageByLabel(context: Context, requestedName: String): String? {
    val launcherIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
    return context.packageManager.queryIntentActivities(launcherIntent, 0)
      .firstOrNull {
        it.loadLabel(context.packageManager).toString().equals(requestedName, ignoreCase = true)
      }
      ?.activityInfo
      ?.packageName
  }

  private fun openSettings(context: Context, payload: JSONObject): JSONObject {
    val page = payload.optString("page")
    val action = when (page) {
      "accessibility" -> Settings.ACTION_ACCESSIBILITY_SETTINGS
      "assistant" -> Settings.ACTION_VOICE_INPUT_SETTINGS
      "wifi" -> Settings.ACTION_WIFI_SETTINGS
      "bluetooth" -> Settings.ACTION_BLUETOOTH_SETTINGS
      "notifications" -> Settings.ACTION_APP_NOTIFICATION_SETTINGS
      "display" -> Settings.ACTION_DISPLAY_SETTINGS
      "sound" -> Settings.ACTION_SOUND_SETTINGS
      "battery" -> Settings.ACTION_BATTERY_SAVER_SETTINGS
      "location" -> Settings.ACTION_LOCATION_SOURCE_SETTINGS
      "security" -> Settings.ACTION_SECURITY_SETTINGS
      "application" -> Settings.ACTION_APPLICATION_DETAILS_SETTINGS
      else -> throw IllegalArgumentException("Unsupported settings page.")
    }
    val intent = Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    if (page == "application") {
      val target = payload.optString("packageName").takeIf { it.isNotBlank() }
        ?: context.packageName
      intent.data = Uri.parse("package:$target")
    } else if (page == "notifications") {
      intent.putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
    }
    (CesiumAccessibilityService.instance ?: context).startActivity(intent)
    return JSONObject().put("opened", true).put("page", page)
  }
}

package com.cesium.mobile.phonecontrol

import android.app.ActivityOptions
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import org.json.JSONObject
import java.lang.ref.WeakReference

object CesiumSecondaryDisplayController {
  private var virtualDisplay: VirtualDisplay? = null
  private var imageReader: ImageReader? = null
  private var activityRef: WeakReference<CesiumSecondaryDisplayActivity>? = null
  private var width = 0
  private var height = 0
  private var title = "Cesium background workspace"
  private var body = "Ready for assistant work."

  fun execute(context: Context, payload: JSONObject): JSONObject {
    return when (payload.optString("action")) {
      "create" -> create(
        context,
        payload.optInt("width", 1080),
        payload.optInt("height", 1920),
        payload.optString("title").takeIf { it.isNotBlank() },
        payload.optString("body").takeIf { it.isNotBlank() }
      )
      "update" -> update(
        payload.optString("title").takeIf { it.isNotBlank() },
        payload.optString("body").takeIf { it.isNotBlank() }
      )
      "close" -> close()
      "status" -> status()
      else -> throw IllegalArgumentException("Unsupported secondary display action.")
    }
  }

  private fun create(
    context: Context,
    requestedWidth: Int,
    requestedHeight: Int,
    requestedTitle: String?,
    requestedBody: String?
  ): JSONObject {
    close()
    width = requestedWidth.coerceIn(320, 2560)
    height = requestedHeight.coerceIn(320, 2560)
    title = requestedTitle ?: "Cesium background workspace"
    body = requestedBody ?: "Ready for assistant work."
    imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
    val manager = context.getSystemService(DisplayManager::class.java)
    virtualDisplay = manager.createVirtualDisplay(
      "CesiumPrivateDisplay",
      width,
      height,
      context.resources.displayMetrics.densityDpi,
      imageReader!!.surface,
      DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY or
        DisplayManager.VIRTUAL_DISPLAY_FLAG_PRESENTATION
    ) ?: throw IllegalStateException("Android refused to create a private display.")

    val displayId = virtualDisplay!!.display.displayId
    val intent = Intent(context, CesiumSecondaryDisplayActivity::class.java).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK)
    }
    val options = ActivityOptions.makeBasic().apply {
      launchDisplayId = displayId
    }
    context.startActivity(intent, options.toBundle())
    return status()
  }

  private fun update(nextTitle: String?, nextBody: String?): JSONObject {
    if (virtualDisplay == null) {
      throw IllegalStateException("No Cesium secondary display exists.")
    }
    if (nextTitle != null) title = nextTitle
    if (nextBody != null) body = nextBody
    activityRef?.get()?.render(title, body)
    return status()
  }

  fun bind(activity: CesiumSecondaryDisplayActivity) {
    activityRef = WeakReference(activity)
    activity.render(title, body)
  }

  fun unbind(activity: CesiumSecondaryDisplayActivity) {
    if (activityRef?.get() === activity) {
      activityRef = null
    }
  }

  private fun close(): JSONObject {
    activityRef?.get()?.finish()
    activityRef = null
    virtualDisplay?.release()
    virtualDisplay = null
    imageReader?.close()
    imageReader = null
    width = 0
    height = 0
    return status()
  }

  fun status(): JSONObject = JSONObject().apply {
    put("active", virtualDisplay != null)
    put("displayId", virtualDisplay?.display?.displayId ?: JSONObject.NULL)
    put("width", width)
    put("height", height)
    put("title", title)
    put("body", body)
    put("visibleToUser", false)
    put("thirdPartyAppsSupported", false)
    put(
      "platformLimit",
      "Android only permits Cesium-owned activities on this private display. Arbitrary third-party app launch requires OEM/signature privileges."
    )
  }
}

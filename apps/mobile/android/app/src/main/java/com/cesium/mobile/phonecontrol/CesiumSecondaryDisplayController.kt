package com.cesium.mobile.phonecontrol

import android.app.ActivityOptions
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * Owns Cesium's private, off-screen VirtualDisplay. Two modes:
 *  - Presentation mode: renders Cesium's own surface (always works for any app).
 *  - App-hosting mode: launches a real third-party app onto the display so the
 *    agent can drive it off-screen. Hosting arbitrary apps on a virtual display
 *    requires the display to be TRUSTED; that is a signature/system privilege on
 *    stock Android, so we attempt it and report the concrete outcome instead of
 *    pretending. Reading/controlling apps that already live on any secondary
 *    display always works through the accessibility multi-display APIs.
 */
object CesiumSecondaryDisplayController {
  // Framework flags that are not all public constants on every SDK.
  private const val FLAG_PUBLIC = DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC
  private const val FLAG_PRESENTATION = DisplayManager.VIRTUAL_DISPLAY_FLAG_PRESENTATION
  private const val FLAG_OWN_CONTENT_ONLY = DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY
  // Hidden framework virtual-display flags (values are stable across releases).
  private const val FLAG_SHOW_SYSTEM_DECORATIONS = 1 shl 9
  private const val FLAG_TRUSTED_VD = 1 shl 10
  private const val FLAG_OWN_DISPLAY_GROUP = 1 shl 11
  // Hidden Display flag indicating the display is trusted to host other apps.
  private const val DISPLAY_FLAG_TRUSTED = 1 shl 4

  private var virtualDisplay: VirtualDisplay? = null
  private var imageReader: ImageReader? = null
  private var presentation: CesiumSecondaryPresentation? = null
  private var width = 0
  private var height = 0
  private var title = "Cesium background workspace"
  private var body = "Ready for assistant work."
  private var hostingApp: String? = null
  private var trustedGranted = false

  fun execute(context: Context, payload: JSONObject): JSONObject {
    return when (payload.optString("action")) {
      "create" -> create(
        context,
        payload.optInt("width", 1080),
        payload.optInt("height", 1920),
        payload.optString("title").takeIf { it.isNotBlank() },
        payload.optString("body").takeIf { it.isNotBlank() }
      )
      "launch_app" -> launchApp(
        context,
        payload.optInt("width", 1080),
        payload.optInt("height", 1920),
        payload.optString("packageName").takeIf { it.isNotBlank() },
        payload.optString("appName").takeIf { it.isNotBlank() }
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

  private fun ensureDisplay(context: Context, w: Int, h: Int, forApps: Boolean) {
    close()
    width = w.coerceIn(320, 2560)
    height = h.coerceIn(320, 2560)
    imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 3)
    val manager = context.getSystemService(DisplayManager::class.java)
    val dpi = context.resources.displayMetrics.densityDpi

    if (forApps) {
      // Hosting other apps' activities needs a trusted, public display with
      // system decorations. Those flags are signature-gated, so try richest to
      // simplest and record which combination the platform actually accepted.
      val attempts = listOf(
        FLAG_PUBLIC or FLAG_PRESENTATION or FLAG_SHOW_SYSTEM_DECORATIONS or FLAG_TRUSTED_VD or FLAG_OWN_DISPLAY_GROUP,
        FLAG_PUBLIC or FLAG_PRESENTATION or FLAG_SHOW_SYSTEM_DECORATIONS or FLAG_TRUSTED_VD,
        FLAG_PUBLIC or FLAG_PRESENTATION or FLAG_SHOW_SYSTEM_DECORATIONS,
        FLAG_PUBLIC or FLAG_PRESENTATION,
        FLAG_PRESENTATION
      )
      for (flags in attempts) {
        virtualDisplay = runCatching {
          manager.createVirtualDisplay("CesiumHostDisplay", width, height, dpi, imageReader!!.surface, flags)
        }.getOrNull()
        if (virtualDisplay != null) break
      }
      trustedGranted = virtualDisplay != null &&
        (virtualDisplay!!.display.flags and DISPLAY_FLAG_TRUSTED) != 0
    } else {
      trustedGranted = false
      virtualDisplay = manager.createVirtualDisplay(
        "CesiumPrivateDisplay", width, height, dpi, imageReader!!.surface,
        FLAG_OWN_CONTENT_ONLY or FLAG_PRESENTATION
      )
    }
    if (virtualDisplay == null) {
      throw IllegalStateException("Android refused to create the secondary display.")
    }
  }

  private fun create(
    context: Context,
    requestedWidth: Int,
    requestedHeight: Int,
    requestedTitle: String?,
    requestedBody: String?
  ): JSONObject {
    ensureDisplay(context, requestedWidth, requestedHeight, forApps = false)
    title = requestedTitle ?: "Cesium background workspace"
    body = requestedBody ?: "Ready for assistant work."
    hostingApp = null
    presentation = CesiumSecondaryPresentation(context, virtualDisplay!!.display).apply {
      render(title, body)
      show()
    }
    return status()
  }

  private fun launchApp(
    context: Context,
    requestedWidth: Int,
    requestedHeight: Int,
    packageName: String?,
    appName: String?
  ): JSONObject {
    val pm = context.packageManager
    val resolvedPackage = packageName
      ?: appName?.let { name ->
        pm.queryIntentActivities(
          Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER),
          0
        ).firstOrNull {
          it.loadLabel(pm).toString().equals(name, ignoreCase = true)
        }?.activityInfo?.packageName
      }
      ?: throw IllegalArgumentException("Provide packageName or a known appName to host off-screen.")
    val launchIntent = pm.getLaunchIntentForPackage(resolvedPackage)
      ?: throw IllegalArgumentException("Package '$resolvedPackage' has no launchable activity.")

    ensureDisplay(context, requestedWidth, requestedHeight, forApps = true)
    val displayId = virtualDisplay!!.display.displayId
    launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK)
    val options = ActivityOptions.makeBasic().apply { launchDisplayId = displayId }

    try {
      context.startActivity(launchIntent, options.toBundle())
    } catch (error: Exception) {
      val detail = if (trustedGranted) {
        "Display is trusted but launch failed: ${error.message ?: error.javaClass.simpleName}"
      } else {
        "Android blocked launching '$resolvedPackage' on this app-owned virtual display because the " +
          "display is not TRUSTED (ADD_TRUSTED_DISPLAY is a system/signature permission). Underlying: " +
          "${error.javaClass.simpleName}: ${error.message}. Cesium can still read and control apps already " +
          "present on any secondary display via phone_displays + phone_snapshot/phone_tap. Full autonomous " +
          "off-screen hosting requires a system-signed build or the companion app-streaming role."
      }
      hostingApp = null
      return status().put("launched", false).put("error", detail)
    }
    hostingApp = resolvedPackage
    return status().put("launched", true).put("hostingPackage", resolvedPackage)
  }

  private fun update(nextTitle: String?, nextBody: String?): JSONObject {
    if (virtualDisplay == null) {
      throw IllegalStateException("No Cesium secondary display exists.")
    }
    if (nextTitle != null) title = nextTitle
    if (nextBody != null) body = nextBody
    presentation?.render(title, body)
    return status()
  }

  private fun close(): JSONObject {
    presentation?.dismiss()
    presentation = null
    virtualDisplay?.release()
    virtualDisplay = null
    imageReader?.close()
    imageReader = null
    hostingApp = null
    trustedGranted = false
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
    put("hostingPackage", hostingApp ?: JSONObject.NULL)
    put("trustedDisplay", trustedGranted)
    put("imageDataUrl", captureImageDataUrl() ?: JSONObject.NULL)
    put("visibleToUser", false)
    put(
      "note",
      "Cesium renders its own surface here and reads/controls any app on this display via the " +
        "accessibility multi-display APIs. Autonomously launching arbitrary third-party apps onto an " +
        "app-owned virtual display additionally needs a TRUSTED display (system/signature)."
    )
  }

  private fun captureImageDataUrl(): String? {
    val reader = imageReader ?: return null
    val image = runCatching { reader.acquireLatestImage() }.getOrNull() ?: return null
    return try {
      val plane = image.planes.firstOrNull() ?: return null
      val pixelStride = plane.pixelStride
      val rowStride = plane.rowStride
      val rowPadding = rowStride - pixelStride * image.width
      val paddedWidth = image.width + rowPadding / pixelStride
      val padded = Bitmap.createBitmap(paddedWidth, image.height, Bitmap.Config.ARGB_8888)
      plane.buffer.rewind()
      padded.copyPixelsFromBuffer(plane.buffer)
      val cropped = if (paddedWidth == image.width) {
        padded
      } else {
        Bitmap.createBitmap(padded, 0, 0, image.width, image.height)
      }
      val output = ByteArrayOutputStream()
      cropped.compress(Bitmap.CompressFormat.JPEG, 80, output)
      if (cropped !== padded) cropped.recycle()
      padded.recycle()
      "data:image/jpeg;base64,${Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)}"
    } finally {
      image.close()
    }
  }

  fun listDisplays(context: Context): JSONArray {
    val manager = context.getSystemService(DisplayManager::class.java)
    val out = JSONArray()
    manager.displays.forEach { display ->
      out.put(JSONObject().apply {
        put("displayId", display.displayId)
        put("name", display.name)
        put("state", display.state)
        @Suppress("DEPRECATION")
        put("width", android.graphics.Point().also { display.getRealSize(it) }.x)
        @Suppress("DEPRECATION")
        put("height", android.graphics.Point().also { display.getRealSize(it) }.y)
        put("trusted", (display.flags and DISPLAY_FLAG_TRUSTED) != 0)
        put("presentation", (display.flags and android.view.Display.FLAG_PRESENTATION) != 0)
        put("cesiumOwned", display.displayId == virtualDisplay?.display?.displayId)
      })
    }
    return out
  }
}

package com.cesium.mobile.phonecontrol

import android.content.Context
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.util.Base64
import org.json.JSONObject
import java.io.ByteArrayOutputStream

object CesiumSecondaryDisplayController {
  private var virtualDisplay: VirtualDisplay? = null
  private var imageReader: ImageReader? = null
  private var presentation: CesiumSecondaryPresentation? = null
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

    presentation = CesiumSecondaryPresentation(
      context,
      virtualDisplay!!.display
    ).apply {
      render(title, body)
      show()
    }
    return status()
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
    put("imageDataUrl", captureImageDataUrl() ?: JSONObject.NULL)
    put("visibleToUser", false)
    put("thirdPartyAppsSupported", false)
    put(
      "platformLimit",
      "Android only permits Cesium-owned activities on this private display. Arbitrary third-party app launch requires OEM/signature privileges."
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
      val padded = Bitmap.createBitmap(
        paddedWidth,
        image.height,
        Bitmap.Config.ARGB_8888
      )
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
}

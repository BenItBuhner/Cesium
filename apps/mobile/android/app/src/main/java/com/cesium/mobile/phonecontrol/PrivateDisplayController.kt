package com.cesium.mobile.phonecontrol

import android.app.ActivityOptions
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.net.Uri
import android.os.Handler
import android.os.HandlerThread
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

class PrivateDisplayController(private val context: Context) {
  private data class Session(
    val width: Int,
    val height: Int,
    val densityDpi: Int,
    val reader: ImageReader,
    val display: VirtualDisplay,
    @Volatile var latestBitmap: Bitmap? = null,
    @Volatile var lastFrameAt: Long = 0
  )

  private val sessions = ConcurrentHashMap<Int, Session>()
  private val frameThread = HandlerThread("CesiumPrivateDisplayFrames").apply { start() }
  private val frameHandler = Handler(frameThread.looper)

  fun create(width: Int, height: Int, densityDpi: Int): JSONObject {
    val safeWidth = width.coerceIn(320, 3840)
    val safeHeight = height.coerceIn(320, 3840)
    val safeDensity = densityDpi.coerceIn(120, 640)
    val reader = ImageReader.newInstance(safeWidth, safeHeight, PixelFormat.RGBA_8888, 3)
    val manager = context.getSystemService(DisplayManager::class.java)
    val virtualDisplay = manager.createVirtualDisplay(
      "Cesium private assistant display",
      safeWidth,
      safeHeight,
      safeDensity,
      reader.surface,
      DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY
    ) ?: run {
      reader.close()
      throw IllegalStateException("Android did not create the private virtual display.")
    }
    val session = Session(safeWidth, safeHeight, safeDensity, reader, virtualDisplay)
    sessions[virtualDisplay.display.displayId] = session
    reader.setOnImageAvailableListener({ source ->
      val image = source.acquireLatestImage() ?: return@setOnImageAvailableListener
      try {
        val now = System.currentTimeMillis()
        if (now - session.lastFrameAt < 250) return@setOnImageAvailableListener
        val bitmap = imageToBitmap(image, safeWidth, safeHeight)
        synchronized(session) {
          session.latestBitmap?.recycle()
          session.latestBitmap = bitmap
          session.lastFrameAt = now
        }
      } finally {
        image.close()
      }
    }, frameHandler)
    return describe(session)
  }

  fun list(): JSONArray {
    val result = JSONArray()
    sessions.values
      .sortedBy { it.display.display.displayId }
      .forEach { result.put(describe(it)) }
    return result
  }

  fun contains(displayId: Int): Boolean = sessions.containsKey(displayId)

  fun destroy(displayId: Int): Boolean {
    val session = sessions.remove(displayId) ?: return false
    session.reader.setOnImageAvailableListener(null, null)
    session.display.release()
    session.reader.close()
    synchronized(session) {
      session.latestBitmap?.recycle()
      session.latestBitmap = null
    }
    return true
  }

  fun capture(displayId: Int, format: String, quality: Int): JSONObject {
    val session = sessions[displayId]
      ?: throw IllegalArgumentException("Unknown Cesium private display: $displayId")
    val copy = synchronized(session) {
      session.latestBitmap?.copy(Bitmap.Config.ARGB_8888, false)
    } ?: throw IllegalStateException(
      "The private display has not rendered a frame yet. Launch an app and retry."
    )
    return try {
      CesiumAccessibilityService.encodeBitmap(copy, displayId, format, quality)
    } finally {
      copy.recycle()
    }
  }

  fun launch(
    displayId: Int,
    packageName: String?,
    uri: String?
  ): JSONObject {
    if (!sessions.containsKey(displayId)) {
      throw IllegalArgumentException("Unknown Cesium private display: $displayId")
    }
    val intent = buildLaunchIntent(packageName, uri).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK)
    }
    val options = ActivityOptions.makeBasic().apply {
      launchDisplayId = displayId
    }
    context.startActivity(intent, options.toBundle())
    return JSONObject()
      .put("ok", true)
      .put("action", "launched_on_private_display")
      .put("displayId", displayId)
      .put("packageName", packageName)
      .put("uri", uri)
      .put(
        "verification",
        "Use mobile_private_display action=capture or mobile_ui_tree with this displayId to verify the target app rendered."
      )
  }

  fun close() {
    sessions.keys.toList().forEach(::destroy)
    frameThread.quitSafely()
  }

  private fun buildLaunchIntent(packageName: String?, uri: String?): Intent {
    if (!uri.isNullOrBlank()) {
      return Intent(Intent.ACTION_VIEW, Uri.parse(uri)).apply {
        if (!packageName.isNullOrBlank()) setPackage(packageName)
      }
    }
    if (packageName.isNullOrBlank()) {
      throw IllegalArgumentException("Provide packageName or uri.")
    }
    return context.packageManager.getLaunchIntentForPackage(packageName)
      ?: Intent(Intent.ACTION_MAIN).apply {
        addCategory(Intent.CATEGORY_LAUNCHER)
        setPackage(packageName)
      }
  }

  private fun describe(session: Session): JSONObject =
    JSONObject()
      .put("displayId", session.display.display.displayId)
      .put("name", session.display.display.name)
      .put("width", session.width)
      .put("height", session.height)
      .put("densityDpi", session.densityDpi)
      .put("private", true)
      .put("hasFrame", session.latestBitmap != null)
      .put("lastFrameAt", session.lastFrameAt.takeIf { it > 0 })

  private fun imageToBitmap(image: Image, width: Int, height: Int): Bitmap {
    val plane = image.planes.first()
    val buffer = plane.buffer
    val pixelStride = plane.pixelStride
    val rowStride = plane.rowStride
    val rowPadding = rowStride - pixelStride * width
    val paddedWidth = width + rowPadding / pixelStride
    val padded = Bitmap.createBitmap(paddedWidth, height, Bitmap.Config.ARGB_8888)
    padded.copyPixelsFromBuffer(buffer)
    if (paddedWidth == width) return padded
    val cropped = Bitmap.createBitmap(padded, 0, 0, width, height)
    padded.recycle()
    return cropped
  }
}

package com.cesium.mobile

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.ByteArrayOutputStream

/**
 * Drains share intents parked in CesiumShareIntentStore into a JS-friendly
 * payload: shared text/subject plus every EXTRA_STREAM attachment read into
 * base64 (the WebView workbench cannot read content:// URIs itself).
 */
class CesiumShareModule(
  private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {
  init {
    // Warm deliveries (onNewIntent while the app is foreground) never change
    // the React Native AppState, so the JS side must be poked explicitly.
    CesiumShareIntentStore.onShareIntent = {
      try {
        if (reactContext.hasActiveReactInstance()) {
          reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(SHARE_EVENT, null)
        }
      } catch (error: Exception) {
        // JS not up yet; the mount/AppState consumers will drain the store.
      }
    }
  }

  override fun getName(): String = "CesiumShare"

  @ReactMethod
  fun addListener(eventName: String) {
    // Required by NativeEventEmitter; events are broadcast unconditionally.
  }

  @ReactMethod
  fun removeListeners(count: Double) {
    // Required by NativeEventEmitter; events are broadcast unconditionally.
  }

  @ReactMethod
  fun consumeSharePayload(promise: Promise) {
    val intent = CesiumShareIntentStore.consume()
    if (intent == null) {
      promise.resolve(null)
      return
    }
    // Content resolver reads + base64 encoding can be several MB of I/O.
    Thread {
      try {
        promise.resolve(readSharePayload(intent))
      } catch (error: Exception) {
        promise.reject("CESIUM_SHARE_READ_FAILED", "Failed to read the shared content.", error)
      }
    }.start()
  }

  private fun readSharePayload(intent: Intent): WritableMap {
    val payload = Arguments.createMap()
    payload.putString("text", intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString())
    payload.putString("subject", intent.getStringExtra(Intent.EXTRA_SUBJECT))

    val files = Arguments.createArray()
    val skipped = Arguments.createArray()
    for (uri in extractStreamUris(intent).take(MAX_FILES)) {
      val file = readSharedFile(uri, intent.type)
      if (file != null) {
        files.pushMap(file)
      } else {
        skipped.pushString(displayName(uri) ?: uri.lastPathSegment ?: "attachment")
      }
    }
    payload.putArray("files", files)
    payload.putArray("skippedFiles", skipped)
    return payload
  }

  private fun extractStreamUris(intent: Intent): List<Uri> {
    return if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java) ?: emptyList()
      } else {
        @Suppress("DEPRECATION")
        intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM) ?: emptyList()
      }
    } else {
      val single = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
      } else {
        @Suppress("DEPRECATION")
        intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
      }
      listOfNotNull(single)
    }
  }

  private fun readSharedFile(uri: Uri, intentType: String?): WritableMap? {
    val resolver = reactContext.contentResolver
    val mimeType = resolver.getType(uri)
      ?: intentType?.takeIf { !it.contains('*') }
      ?: "application/octet-stream"
    val name = displayName(uri) ?: uri.lastPathSegment?.substringAfterLast('/') ?: "attachment"
    val maxBytes = if (mimeType.startsWith("image/")) MAX_IMAGE_BYTES else MAX_FILE_BYTES

    val bytes = resolver.openInputStream(uri)?.use { input ->
      val buffer = ByteArrayOutputStream()
      val chunk = ByteArray(16 * 1024)
      var total = 0
      while (true) {
        val read = input.read(chunk)
        if (read <= 0) {
          break
        }
        total += read
        if (total > maxBytes) {
          return null
        }
        buffer.write(chunk, 0, read)
      }
      buffer.toByteArray()
    } ?: return null

    return Arguments.createMap().apply {
      putString("name", name)
      putString("mimeType", mimeType)
      putString("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
      putInt("byteLength", bytes.size)
    }
  }

  private fun displayName(uri: Uri): String? {
    return try {
      reactContext.contentResolver
        .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
        ?.use { cursor ->
          val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          if (index >= 0 && cursor.moveToFirst()) cursor.getString(index) else null
        }
    } catch (error: Exception) {
      null
    }
  }

  companion object {
    /** DeviceEventEmitter event poking JS to drain the share store. */
    const val SHARE_EVENT = "cesiumShareIntent"
    /** Matches the composer's attachment cap. */
    private const val MAX_FILES = 10
    /** Matches the composer's inline-image limit. */
    private const val MAX_IMAGE_BYTES = 10 * 1024 * 1024
    /** Generic files cross the RN bridge as base64; keep them bounded. */
    private const val MAX_FILE_BYTES = 25 * 1024 * 1024
  }
}

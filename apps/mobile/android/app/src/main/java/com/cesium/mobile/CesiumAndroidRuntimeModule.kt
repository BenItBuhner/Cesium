package com.cesium.mobile

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.Base64
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.ByteArrayOutputStream
import java.io.File

class CesiumAndroidRuntimeModule(
  private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext), ActivityEventListener {
  private var pickPromise: Promise? = null

  init {
    reactContext.addActivityEventListener(this)
  }

  override fun getName(): String = "CesiumAndroidRuntime"

  @ReactMethod
  fun getRuntimeConfig(promise: Promise) {
    try {
      promise.resolve(runtimeConfigMap())
    } catch (error: Exception) {
      promise.reject(
        "CESIUM_ANDROID_RUNTIME_CONFIG_FAILED",
        "Failed to prepare Cesium Android runtime directories",
        error
      )
    }
  }

  @ReactMethod
  fun pickImages(allowMultiple: Boolean, promise: Promise) {
    if (pickPromise != null) {
      promise.reject("CESIUM_PICK_IN_PROGRESS", "An image picker is already open.")
      return
    }
    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.reject("CESIUM_NO_ACTIVITY", "No Android activity is available to pick images.")
      return
    }
    pickPromise = promise
    val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
      type = "image/*"
      addCategory(Intent.CATEGORY_OPENABLE)
      putExtra(Intent.EXTRA_ALLOW_MULTIPLE, allowMultiple)
    }
    try {
      activity.startActivityForResult(
        Intent.createChooser(intent, "Attach images"),
        PICK_IMAGES_REQUEST
      )
    } catch (error: Exception) {
      pickPromise = null
      promise.reject("CESIUM_PICK_FAILED", "Failed to open the system image picker.", error)
    }
  }

  override fun onActivityResult(
    activity: Activity,
    requestCode: Int,
    resultCode: Int,
    data: Intent?
  ) {
    if (requestCode != PICK_IMAGES_REQUEST) {
      return
    }
    val promise = pickPromise ?: return
    pickPromise = null
    if (resultCode != Activity.RESULT_OK || data == null) {
      promise.resolve(Arguments.createArray())
      return
    }
    try {
      promise.resolve(readPickedImages(data))
    } catch (error: Exception) {
      promise.reject("CESIUM_PICK_READ_FAILED", "Failed to read the selected images.", error)
    }
  }

  override fun onNewIntent(intent: Intent) {
    if (!reactContext.hasActiveReactInstance()) {
      return
    }
    // A notification tap can land while the activity is already resumed and
    // top-most (shade pulled down over the running app). AppState never flips
    // in that case, so JS would not poll `consumeInitialNotificationAction`
    // on its own - nudge it. MainActivity stages the intent in
    // CesiumNotificationIntentStore before super.onNewIntent() reaches this
    // listener.
    if (intent.getStringExtra("cesiumAction") != null) {
      reactContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(NOTIFICATION_ACTION_EVENT, null)
      return
    }
    // A share can arrive while the activity is already resumed and top-most
    // (e.g. sharing from a split-screen or freeform-window app). AppState never
    // flips in that case, so JS would not poll `consumeSharedPayload` on its
    // own - nudge it. MainActivity stages the payload in CesiumShareIntentStore
    // before super.onNewIntent() reaches this listener.
    val action = intent.action
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) {
      return
    }
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(SHARE_INTAKE_EVENT, null)
  }

  /**
   * Drains the pending share-sheet intent (if any) into a JS-friendly payload:
   * shared text/subject plus every shared stream read into base64. Returns
   * null when nothing was shared since the last call.
   */
  @ReactMethod
  fun consumeSharedPayload(promise: Promise) {
    try {
      val intent = CesiumShareIntentStore.consume()
      if (intent == null) {
        promise.resolve(null)
        return
      }
      promise.resolve(readSharedPayload(intent))
    } catch (error: Exception) {
      promise.reject("CESIUM_SHARE_READ_FAILED", "Failed to read the shared content.", error)
    }
  }

  private fun readSharedPayload(intent: Intent): WritableMap {
    val uris = mutableListOf<Uri>()
    if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
      val streams = if (Build.VERSION.SDK_INT >= 33) {
        intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
      } else {
        @Suppress("DEPRECATION")
        intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
      }
      streams?.filterNotNull()?.let(uris::addAll)
    } else {
      val stream = if (Build.VERSION.SDK_INT >= 33) {
        intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
      } else {
        @Suppress("DEPRECATION")
        intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
      }
      stream?.let(uris::add)
    }

    val items = Arguments.createArray()
    var skipped = 0
    for (uri in uris.take(MAX_SHARED_ITEMS)) {
      val item = readSharedItem(uri, intent.type)
      if (item != null) {
        items.pushMap(item)
      } else {
        skipped += 1
      }
    }
    skipped += maxOf(0, uris.size - MAX_SHARED_ITEMS)

    return Arguments.createMap().apply {
      putString("text", intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString())
      putString("subject", intent.getStringExtra(Intent.EXTRA_SUBJECT))
      putArray("items", items)
      putInt("skippedCount", skipped)
    }
  }

  private fun readSharedItem(uri: Uri, fallbackMimeType: String?): WritableMap? {
    val resolver = reactContext.contentResolver
    val mimeType = resolver.getType(uri)
      ?: fallbackMimeType?.takeIf { !it.contains('*') }
      ?: "application/octet-stream"
    val name = querySharedDisplayName(uri)
      ?: uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() }
      ?: "shared-file"
    val bytes = try {
      resolver.openInputStream(uri)?.use { input ->
        val buffer = ByteArrayOutputStream()
        val chunk = ByteArray(16 * 1024)
        var total = 0
        while (true) {
          val read = input.read(chunk)
          if (read <= 0) {
            break
          }
          total += read
          if (total > MAX_SHARED_FILE_BYTES) {
            return null
          }
          buffer.write(chunk, 0, read)
        }
        buffer.toByteArray()
      }
    } catch (_: Exception) {
      null
    } ?: return null

    return Arguments.createMap().apply {
      putString("name", name)
      putString("mimeType", mimeType)
      putString("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
      putInt("byteLength", bytes.size)
    }
  }

  private fun querySharedDisplayName(uri: Uri): String? {
    return try {
      reactContext.contentResolver
        .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
        ?.use { cursor ->
          if (cursor.moveToFirst()) cursor.getString(0)?.takeIf { it.isNotBlank() } else null
        }
    } catch (_: Exception) {
      null
    }
  }

  private fun readPickedImages(data: Intent): WritableArray {
    val uris = mutableListOf<Uri>()
    val clip = data.clipData
    if (clip != null) {
      for (index in 0 until clip.itemCount) {
        clip.getItemAt(index)?.uri?.let(uris::add)
      }
    } else {
      data.data?.let(uris::add)
    }

    val results = Arguments.createArray()
    for (uri in uris.take(MAX_IMAGES)) {
      readImage(uri)?.let(results::pushMap)
    }
    return results
  }

  private fun readImage(uri: Uri): WritableMap? {
    val resolver = reactContext.contentResolver
    val mimeType = resolver.getType(uri)?.takeIf { it.startsWith("image/") } ?: "image/jpeg"
    val name = uri.lastPathSegment?.substringAfterLast('/') ?: "image.jpg"
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
        if (total > MAX_IMAGE_BYTES) {
          return null
        }
        buffer.write(chunk, 0, read)
      }
      buffer.toByteArray()
    } ?: return null

    return Arguments.createMap().apply {
      putString("uri", uri.toString())
      putString("mimeType", mimeType)
      putString("name", name)
      putString("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
      putInt("byteLength", bytes.size)
    }
  }

  private fun runtimeConfigMap() = Arguments.createMap().apply {
    val filesRoot = reactContext.filesDir
    val projectsDir = File(filesRoot, "projects")
    val serverDataDir = File(filesRoot, "server-data")
    val defaultWorkspaceRoot = File(projectsDir, "default")

    ensureDirectory(projectsDir)
    ensureDirectory(serverDataDir)
    ensureDirectory(defaultWorkspaceRoot)

    putString("projectsDir", projectsDir.absolutePath)
    putString("serverDataDir", serverDataDir.absolutePath)
    putString("defaultWorkspaceRoot", defaultWorkspaceRoot.absolutePath)
    putArray("allowedWorkspaceRoots", Arguments.createArray().apply {
      pushString(projectsDir.absolutePath)
    })
    putMap("backendEnvironment", Arguments.createMap().apply {
      putString("HOST", "127.0.0.1")
      putString("OPENCURSOR_DATA_DIR", serverDataDir.absolutePath)
      putString("OPENCURSOR_STORAGE_DRIVER", "legacy-json")
      putString("WORKSPACE_ALLOWED_ROOTS", projectsDir.absolutePath)
      putString("WORKSPACE_ROOT", defaultWorkspaceRoot.absolutePath)
    })
    putBoolean("localBackendReady", false)
  }

  private fun ensureDirectory(directory: File) {
    if (!directory.exists() && !directory.mkdirs()) {
      throw IllegalStateException("Could not create ${directory.absolutePath}")
    }
    if (!directory.isDirectory) {
      throw IllegalStateException("${directory.absolutePath} is not a directory")
    }
  }

  companion object {
    private const val PICK_IMAGES_REQUEST = 0xCE51
    private const val MAX_IMAGES = 10
    private const val MAX_IMAGE_BYTES = 10 * 1024 * 1024
    // Composer caps mirrored natively: at most 10 attachments per message, and
    // each shared stream is base64-encoded across the RN bridge, so keep a
    // conservative per-item byte cap to protect bridge throughput.
    private const val MAX_SHARED_ITEMS = 10

    /** DeviceEventEmitter event telling JS a share intent is waiting in the store. */
    const val SHARE_INTAKE_EVENT = "cesiumShareIntakeAvailable"

    /** DeviceEventEmitter event telling JS a notification action is waiting in the store. */
    const val NOTIFICATION_ACTION_EVENT = "cesiumNotificationActionAvailable"
    private const val MAX_SHARED_FILE_BYTES = 25 * 1024 * 1024
  }
}

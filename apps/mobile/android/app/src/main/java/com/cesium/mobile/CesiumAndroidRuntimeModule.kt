package com.cesium.mobile

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.util.Base64
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
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
    // Notification intents are handled by MainActivity.
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
  }
}

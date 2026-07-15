package com.cesium.mobile

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

class CesiumAndroidRuntimeModule(
  private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {
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
}

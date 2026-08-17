package com.cesium.mobile

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File

/**
 * Temporary stability diagnostics. Each line is valid NDJSON and is mirrored
 * to Logcat so a physical-device run can stream it to the host debug log.
 */
object CesiumDebugLog {
  private const val TAG = "CesiumDebug"
  private const val FILE_NAME = "debug.log"

  fun write(
    context: Context,
    hypothesisId: String,
    location: String,
    message: String,
    data: JSONObject = JSONObject()
  ) {
    write(
      context,
      JSONObject()
        .put("hypothesisId", hypothesisId)
        .put("location", location)
        .put("message", message)
        .put("data", data)
        .put("timestamp", System.currentTimeMillis())
    )
  }

  fun write(context: Context, payload: JSONObject) {
    val line = payload.toString()
    // region agent log
    Log.i(TAG, line)
    runCatching {
      File(context.filesDir, FILE_NAME).appendText("$line\n")
    }
    // endregion
  }
}

package com.cesium.mobile.assistant

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.cesium.mobile.phonecontrol.PhoneControlPreferences
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Speech-to-text for the overlay's mic button. Records a short m4a via
 * MediaRecorder and uploads it to the Cesium server's
 * POST /api/audio/transcriptions endpoint (an OpenAI-compatible Whisper proxy),
 * returning the recognized text. Recording is push-to-talk: start on press,
 * stop + transcribe on release.
 */
class CesiumVoiceRecorder(private val context: Context) {
  private val handler = Handler(Looper.getMainLooper())
  private val client = OkHttpClient.Builder()
    .connectTimeout(10, TimeUnit.SECONDS)
    .readTimeout(60, TimeUnit.SECONDS)
    .build()
  private var recorder: MediaRecorder? = null
  private var outputFile: File? = null
  private var recording = false

  val isRecording: Boolean get() = recording

  fun start(): Boolean {
    if (recording) return true
    val file = File(context.cacheDir, "cesium-stt-${System.currentTimeMillis()}.m4a")
    val rec = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else @Suppress("DEPRECATION") MediaRecorder()
    return try {
      rec.setAudioSource(MediaRecorder.AudioSource.MIC)
      rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
      rec.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
      rec.setAudioSamplingRate(16_000)
      rec.setAudioEncodingBitRate(48_000)
      rec.setOutputFile(file.absolutePath)
      rec.prepare()
      rec.start()
      recorder = rec
      outputFile = file
      recording = true
      true
    } catch (error: Exception) {
      runCatching { rec.release() }
      false
    }
  }

  /** Stops recording and transcribes. onResult is posted to the main thread. */
  fun stopAndTranscribe(onResult: (text: String?, error: String?) -> Unit) {
    if (!recording) {
      onResult(null, "Not recording.")
      return
    }
    recording = false
    val file = outputFile
    try {
      recorder?.stop()
    } catch (_: Exception) {
      // A too-short recording throws; treat as empty.
    } finally {
      runCatching { recorder?.release() }
      recorder = null
    }
    if (file == null || !file.isFile || file.length() < 1_200) {
      onResult(null, "Didn't catch any audio.")
      return
    }
    val config = PhoneControlPreferences.read(context)
    if (config.serverUrl.isBlank()) {
      onResult(null, "Connect a Cesium server first.")
      return
    }
    val body = MultipartBody.Builder()
      .setType(MultipartBody.FORM)
      .addFormDataPart("file", file.name, file.asRequestBody("audio/mp4".toMediaType()))
      .build()
    val builder = Request.Builder()
      .url("${config.serverUrl.trimEnd('/')}/api/audio/transcriptions")
      .header("Accept", "application/json")
      .post(body)
    config.authToken?.let { builder.header("x-opencursor-session-token", it) }
    client.newCall(builder.build()).enqueue(object : Callback {
      override fun onFailure(call: Call, error: IOException) {
        file.delete()
        handler.post { onResult(null, "Transcription request failed: ${error.message}") }
      }

      override fun onResponse(call: Call, response: Response) {
        response.use {
          val raw = it.body?.string() ?: "{}"
          file.delete()
          if (!it.isSuccessful) {
            val message = runCatching { JSONObject(raw).optString("error") }.getOrNull()
            handler.post {
              onResult(null, message?.takeIf(String::isNotBlank) ?: "Transcription unavailable (HTTP ${it.code}).")
            }
            return
          }
          val text = runCatching { JSONObject(raw).optString("text").trim() }.getOrNull()
          handler.post { onResult(text?.takeIf(String::isNotBlank), if (text.isNullOrBlank()) "No speech detected." else null) }
        }
      }
    })
  }

  fun cancel() {
    if (recording) {
      recording = false
      runCatching { recorder?.stop() }
      runCatching { recorder?.release() }
      recorder = null
    }
    outputFile?.delete()
  }
}

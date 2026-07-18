package com.cesium.mobile.assistant

import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognitionService
import android.speech.SpeechRecognizer

/**
 * VoiceInteractionService metadata requires an in-package RecognitionService.
 * Cesium delegates to the device's installed recognizer instead of pretending
 * to provide its own speech model.
 */
class CesiumRecognitionService : RecognitionService() {
  private var recognizer: SpeechRecognizer? = null
  private var activeCallback: Callback? = null

  override fun onCreate() {
    super.onCreate()
    val delegate = findDelegate()
    if (delegate != null) {
      recognizer = SpeechRecognizer.createSpeechRecognizer(this, delegate)
    }
  }

  override fun onStartListening(recognizerIntent: Intent, callback: Callback) {
    val target = recognizer
    if (target == null) {
      callback.error(SpeechRecognizer.ERROR_CLIENT)
      return
    }
    activeCallback = callback
    target.setRecognitionListener(object : RecognitionListener {
      override fun onReadyForSpeech(params: Bundle?) = callback.readyForSpeech(params ?: Bundle())
      override fun onBeginningOfSpeech() = callback.beginningOfSpeech()
      override fun onRmsChanged(rmsdB: Float) = callback.rmsChanged(rmsdB)
      override fun onBufferReceived(buffer: ByteArray?) {
        if (buffer != null) callback.bufferReceived(buffer)
      }
      override fun onEndOfSpeech() = callback.endOfSpeech()
      override fun onError(error: Int) {
        activeCallback = null
        callback.error(error)
      }
      override fun onResults(results: Bundle?) {
        activeCallback = null
        callback.results(results ?: Bundle())
      }
      override fun onPartialResults(partialResults: Bundle?) =
        callback.partialResults(partialResults ?: Bundle())
      override fun onEvent(eventType: Int, params: Bundle?) = Unit
    })
    target.startListening(recognizerIntent)
  }

  override fun onStopListening(callback: Callback) {
    if (callback === activeCallback) recognizer?.stopListening()
  }

  override fun onCancel(callback: Callback) {
    if (callback === activeCallback) {
      activeCallback = null
      recognizer?.cancel()
    }
  }

  override fun onDestroy() {
    recognizer?.destroy()
    recognizer = null
    activeCallback = null
    super.onDestroy()
  }

  private fun findDelegate(): ComponentName? {
    val intent = Intent(RecognitionService.SERVICE_INTERFACE)
    return packageManager.queryIntentServices(intent, 0)
      .asSequence()
      .map { it.serviceInfo }
      .filter { it.packageName != packageName }
      .sortedByDescending { (it.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0 }
      .map { ComponentName(it.packageName, it.name) }
      .firstOrNull()
  }
}

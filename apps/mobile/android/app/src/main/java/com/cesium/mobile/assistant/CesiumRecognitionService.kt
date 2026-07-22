package com.cesium.mobile.assistant

import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionService
import android.speech.SpeechRecognizer

/**
 * Qualifies Cesium as a complete Android voice-interaction service. The system
 * assistant overlay currently accepts typed requests; OEM builds can replace
 * this service with an on-device recognizer without changing assistant wiring.
 */
class CesiumRecognitionService : RecognitionService() {
  override fun onStartListening(
    recognizerIntent: Intent?,
    listener: Callback?
  ) {
    listener?.error(SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED)
  }

  override fun onCancel(listener: Callback?) = Unit

  override fun onStopListening(listener: Callback?) {
    listener?.results(Bundle().apply {
      putStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION, arrayListOf())
    })
  }
}

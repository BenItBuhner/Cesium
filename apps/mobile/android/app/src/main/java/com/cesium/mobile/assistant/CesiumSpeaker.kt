package com.cesium.mobile.assistant

import android.content.Context
import android.speech.tts.TextToSpeech
import java.util.Locale

/**
 * On-device text-to-speech for the assistant's final answer. Uses Android's
 * built-in TextToSpeech engine (no server round-trip, works offline), so the
 * user hears the result even when the overlay has been minimized to the corner
 * over another app.
 */
class CesiumSpeaker(context: Context) {
  private var ready = false
  private var pending: String? = null
  private val tts = TextToSpeech(context.applicationContext) { status ->
    ready = status == TextToSpeech.SUCCESS
    if (ready) {
      runCatching { engineLocale() }
      pending?.let { speakNow(it) }
      pending = null
    }
  }

  private fun engineLocale() {
    val result = tts.setLanguage(Locale.getDefault())
    if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
      tts.language = Locale.US
    }
  }

  fun speak(text: String) {
    val clean = text.trim()
    if (clean.isEmpty()) return
    val capped = if (clean.length > 3500) clean.take(3500) + "…" else clean
    if (!ready) {
      pending = capped
      return
    }
    speakNow(capped)
  }

  private fun speakNow(text: String) {
    tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "cesium-answer")
  }

  fun stop() {
    pending = null
    runCatching { tts.stop() }
  }

  fun shutdown() {
    runCatching { tts.stop() }
    runCatching { tts.shutdown() }
  }
}

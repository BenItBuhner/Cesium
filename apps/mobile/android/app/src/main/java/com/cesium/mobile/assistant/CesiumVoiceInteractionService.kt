package com.cesium.mobile.assistant

import android.os.Bundle
import android.service.voice.VoiceInteractionService
import android.service.voice.VoiceInteractionSession

class CesiumVoiceInteractionService : VoiceInteractionService() {
  override fun onLaunchVoiceAssistFromKeyguard() {
    showCesiumSession()
  }

  override fun onReady() {
    super.onReady()
    current = this
  }

  override fun onShutdown() {
    if (current === this) current = null
    super.onShutdown()
  }

  private fun showCesiumSession() {
    showSession(
      Bundle(),
      VoiceInteractionSession.SHOW_WITH_ASSIST or
        VoiceInteractionSession.SHOW_WITH_SCREENSHOT
    )
  }

  companion object {
    @Volatile
    var current: CesiumVoiceInteractionService? = null
      private set

    fun show(): Boolean {
      val service = current ?: return false
      service.showCesiumSession()
      return true
    }
  }
}

package com.cesium.mobile.assistant

import android.os.Bundle
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService

class CesiumVoiceInteractionSessionService : VoiceInteractionSessionService() {
  override fun onNewSession(args: Bundle?): VoiceInteractionSession =
    CesiumVoiceInteractionSession(this)
}

package com.cesium.mobile.assistant

import android.content.Context
import android.graphics.Bitmap

/**
 * Process-level owner of a single assistant run so its state (status + streamed
 * answer) survives the overlay being minimized to the corner bubble or fully
 * dismissed. The visible surfaces — the expanded session panel and the floating
 * bubble — are thin observers of this controller. When a run finishes, the final
 * answer is spoken aloud (useful when the user has parked the bubble over another
 * app).
 */
object CesiumAssistantController {
  data class State(
    val running: Boolean = false,
    val status: String = "",
    val answer: String = "",
    val terminal: Boolean = false,
    val ok: Boolean = false,
    val request: String = ""
  )

  fun interface Listener {
    fun onState(state: State)
  }

  @Volatile
  var state = State()
    private set

  private val listeners = mutableSetOf<Listener>()
  private var client: CesiumAssistantClient? = null
  private var speaker: CesiumSpeaker? = null
  private var spokenFor = ""

  fun addListener(context: Context, listener: Listener) {
    synchronized(listeners) { listeners.add(listener) }
    if (speaker == null) speaker = CesiumSpeaker(context.applicationContext)
    listener.onState(state)
  }

  fun removeListener(listener: Listener) {
    synchronized(listeners) { listeners.remove(listener) }
  }

  fun start(context: Context, request: String, screenContext: String, screenshot: Bitmap?) {
    if (state.running) return
    if (client == null) client = CesiumAssistantClient(context.applicationContext)
    if (speaker == null) speaker = CesiumSpeaker(context.applicationContext)
    spokenFor = ""
    emit(State(running = true, status = "Starting agent…", request = request))
    client!!.createAgent(request, screenContext, screenshot) { status, answer ->
      val terminal = status == "Done" ||
        status.startsWith("Agent failed") ||
        status.startsWith("Agent cancelled") ||
        status.startsWith("Could not reach") ||
        status.startsWith("Server returned") ||
        status.startsWith("Open Cesium")
      val next = state.copy(
        running = !terminal,
        status = status,
        answer = answer ?: state.answer,
        terminal = terminal,
        ok = status == "Done"
      )
      emit(next)
      if (next.ok && next.answer.isNotBlank() && spokenFor != next.answer) {
        spokenFor = next.answer
        speaker?.speak(Markdown.toSpeech(next.answer))
      }
    }
  }

  fun reset() {
    speaker?.stop()
    emit(State())
  }

  private fun emit(next: State) {
    state = next
    val snapshot = synchronized(listeners) { listeners.toList() }
    snapshot.forEach { runCatching { it.onState(next) } }
  }
}

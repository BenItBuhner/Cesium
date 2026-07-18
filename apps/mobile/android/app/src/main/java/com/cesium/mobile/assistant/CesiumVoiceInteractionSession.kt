package com.cesium.mobile.assistant

import android.Manifest
import android.app.assist.AssistContent
import android.app.assist.AssistStructure
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.service.voice.VoiceInteractionSession
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.content.ContextCompat
import java.io.ByteArrayOutputStream
import java.util.Base64
import java.util.Locale

class CesiumVoiceInteractionSession(context: Context) : VoiceInteractionSession(context) {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val agentClient = AssistantAgentClient(context)
  private var speechRecognizer: SpeechRecognizer? = null
  private var screenshotBase64: String? = null
  private var screenContext: String? = null
  private lateinit var input: EditText
  private lateinit var status: TextView
  private lateinit var response: TextView
  private lateinit var send: Button
  private lateinit var screenshotToggle: CheckBox
  private lateinit var speak: Button

  override fun onCreateContentView(): View {
    val panel = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER_HORIZONTAL
      setPadding(dp(20), dp(18), dp(20), dp(20))
      background = GradientDrawable().apply {
        setColor(Color.rgb(24, 24, 27))
        cornerRadius = dp(24).toFloat()
        setStroke(dp(1), Color.rgb(63, 63, 70))
      }
    }
    panel.addView(TextView(context).apply {
      text = "Cesium"
      textSize = 22f
      setTextColor(Color.WHITE)
      setTypeface(typeface, android.graphics.Typeface.BOLD)
    }, matchWrap())
    status = TextView(context).apply {
      text = "Ask about what is on screen or request an action."
      textSize = 13f
      setTextColor(Color.rgb(161, 161, 170))
      gravity = Gravity.CENTER
      setPadding(0, dp(5), 0, dp(12))
    }
    panel.addView(status, matchWrap())
    input = EditText(context).apply {
      hint = "What should Cesium do?"
      setHintTextColor(Color.rgb(113, 113, 122))
      setTextColor(Color.WHITE)
      textSize = 16f
      minLines = 2
      maxLines = 5
      gravity = Gravity.TOP
      setPadding(dp(14), dp(12), dp(14), dp(12))
      background = rounded(Color.rgb(39, 39, 42), 14)
    }
    panel.addView(input, LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ))
    screenshotToggle = CheckBox(context).apply {
      text = "Include screenshot (multimodal models)"
      setTextColor(Color.rgb(212, 212, 216))
      textSize = 13f
      isChecked = false
      isEnabled = screenshotBase64 != null
    }
    panel.addView(screenshotToggle, matchWrap())
    val controls = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.END
    }
    controls.addView(Button(context).apply {
      text = "Dismiss"
      setOnClickListener { finish() }
    })
    speak = Button(context).apply {
      text = "Speak"
      setOnClickListener { startListening() }
    }
    controls.addView(speak)
    send = Button(context).apply {
      text = "Send"
      setOnClickListener { submit() }
    }
    controls.addView(send)
    panel.addView(controls, LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    ))
    response = TextView(context).apply {
      setTextColor(Color.rgb(228, 228, 231))
      textSize = 14f
      setTextIsSelectable(true)
      setPadding(0, dp(8), 0, 0)
    }
    panel.addView(ScrollView(context).apply {
      addView(response)
    }, LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      0,
      1f
    ))
    return LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.BOTTOM
      setPadding(dp(12), dp(12), dp(12), dp(12))
      addView(panel, LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        dp(420)
      ))
    }
  }

  override fun onShow(args: Bundle?, showFlags: Int) {
    super.onShow(args, showFlags)
    mainHandler.postDelayed({ startListening() }, 350)
  }

  override fun onHandleAssist(
    data: Bundle?,
    structure: AssistStructure?,
    content: AssistContent?
  ) {
    screenContext = structure?.let(::summarizeStructure)
    mainHandler.post {
      val app = structure?.activityComponent?.packageName
      status.text =
        if (app.isNullOrBlank()) "Screen context may be unavailable for this app."
        else "Context received from $app"
    }
  }

  override fun onHandleScreenshot(screenshot: Bitmap?) {
    screenshotBase64 = screenshot?.let(::encodeScreenshot)
    mainHandler.post {
      screenshotToggle.isEnabled = screenshotBase64 != null
    }
  }

  override fun onHide() {
    stopSpeech()
    agentClient.stopPolling()
    super.onHide()
  }

  override fun onDestroy() {
    stopSpeech()
    speechRecognizer?.destroy()
    speechRecognizer = null
    agentClient.stopPolling()
    super.onDestroy()
  }

  private fun submit() {
    val prompt = input.text.toString().trim()
    if (prompt.isBlank()) {
      status.text = "Type or speak a request first."
      return
    }
    stopSpeech()
    send.isEnabled = false
    speak.isEnabled = false
    status.text = "Starting a Cesium agent…"
    agentClient.submit(
      prompt,
      screenContext,
      screenshotBase64.takeIf { screenshotToggle.isChecked },
      object : AssistantAgentClient.Listener {
        override fun onStarted(conversationId: String) {
          mainHandler.post {
            status.text = "Agent running. You can dismiss this overlay safely."
          }
        }

        override fun onUpdate(text: String, runStatus: String) {
          mainHandler.post {
            if (text.isNotBlank()) response.text = text
            status.text = when (runStatus) {
              "running" -> "Cesium is working… You can dismiss this overlay."
              "awaiting_permission" -> "Open Cesium to answer a permission request."
              "awaiting_question" -> "Open Cesium to answer a question."
              "failed" -> "The agent failed. Open Cesium for details."
              else -> "Agent $runStatus"
            }
          }
        }

        override fun onError(message: String) {
          mainHandler.post {
            status.text = message
            send.isEnabled = true
            speak.isEnabled = true
          }
        }
      }
    )
  }

  private fun startListening() {
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      status.text = "Grant microphone access in Cesium to use voice input."
      return
    }
    if (!SpeechRecognizer.isRecognitionAvailable(context)) {
      status.text = "Speech recognition is unavailable; type the request instead."
      return
    }
    if (speechRecognizer == null) {
      speechRecognizer =
        if (
          Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
          SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
        ) {
          SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
        } else {
          SpeechRecognizer.createSpeechRecognizer(context)
        }
      speechRecognizer?.setRecognitionListener(object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {
          status.text = "Listening…"
          speak.text = "Listening"
        }

        override fun onBeginningOfSpeech() = Unit
        override fun onRmsChanged(rmsdB: Float) = Unit
        override fun onBufferReceived(buffer: ByteArray?) = Unit
        override fun onEndOfSpeech() {
          status.text = "Transcribing…"
        }

        override fun onError(error: Int) {
          status.text = "Voice input stopped. Type or tap Speak to retry."
          speak.text = "Speak"
        }

        override fun onResults(results: Bundle?) {
          applySpeech(results)
          speak.text = "Speak"
          status.text = "Ready to send."
        }

        override fun onPartialResults(partialResults: Bundle?) {
          applySpeech(partialResults)
        }

        override fun onEvent(eventType: Int, params: Bundle?) = Unit
      })
    }
    speechRecognizer?.startListening(
      Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_PROMPT, "Ask Cesium")
      }
    )
  }

  private fun stopSpeech() {
    try {
      speechRecognizer?.stopListening()
    } catch (_: Throwable) {
      // SpeechRecognizer may already be stopped.
    }
  }

  private fun applySpeech(bundle: Bundle?) {
    val values = bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
    val text = values?.firstOrNull()?.trim().orEmpty()
    if (text.isNotBlank()) input.setText(text)
  }

  private fun summarizeStructure(structure: AssistStructure): String {
    val lines = mutableListOf<String>()
    lines += "Foreground package: ${structure.activityComponent?.packageName ?: "unknown"}"
    lines += "Foreground activity: ${structure.activityComponent?.className ?: "unknown"}"
    var count = 0
    fun walk(node: AssistStructure.ViewNode, depth: Int) {
      if (count >= 300 || depth > 20) return
      count += 1
      val label = listOfNotNull(
        node.text?.toString()?.takeIf { it.isNotBlank() },
        node.contentDescription?.toString()?.takeIf { it.isNotBlank() },
        node.idEntry?.takeIf { it.isNotBlank() }
      ).joinToString(" | ")
      if (label.isNotBlank()) {
        lines += "${node.className ?: "View"}: ${label.take(300)}"
      }
      for (index in 0 until node.childCount) walk(node.getChildAt(index), depth + 1)
    }
    for (window in 0 until structure.windowNodeCount) {
      walk(structure.getWindowNodeAt(window).rootViewNode, 0)
    }
    return lines.joinToString("\n").take(12_000)
  }

  private fun encodeScreenshot(bitmap: Bitmap): String =
    ByteArrayOutputStream().use { output ->
      bitmap.compress(Bitmap.CompressFormat.JPEG, 76, output)
      Base64.getEncoder().encodeToString(output.toByteArray())
    }

  private fun rounded(color: Int, radiusDp: Int) = GradientDrawable().apply {
    setColor(color)
    cornerRadius = dp(radiusDp).toFloat()
  }

  private fun matchWrap() = LinearLayout.LayoutParams(
    ViewGroup.LayoutParams.MATCH_PARENT,
    ViewGroup.LayoutParams.WRAP_CONTENT
  )

  private fun dp(value: Int): Int =
    (value * context.resources.displayMetrics.density).toInt()
}

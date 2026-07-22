package com.cesium.mobile.assistant

import android.Manifest
import android.app.assist.AssistContent
import android.app.assist.AssistStructure
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Typeface
import android.os.Bundle
import android.service.voice.VoiceInteractionSession
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import com.cesium.mobile.MainActivity

/**
 * Cesium's system-assistant surface. A single, clean bottom sheet: a prompt
 * field with a mic (speech-to-text) button and a Send button, plus Minimize
 * (park it as a floating bubble over other apps) and Open. The agent's reply is
 * rendered as Markdown and read aloud. There is no "screen context ready" chrome
 * and no auto-pasting suggestion chips — the live screen is available to the
 * agent as phone tools (phone_snapshot / phone_screenshot / phone_tap …), and a
 * screenshot is attached automatically only when the user actually refers to the
 * screen in their prompt.
 */
class CesiumVoiceInteractionSession(context: Context) : VoiceInteractionSession(context) {
  private var assistContext = ""
  private var capturedScreenshot: Bitmap? = null
  private val recorder = CesiumVoiceRecorder(context)

  private lateinit var requestInput: EditText
  private lateinit var micButton: TextView
  private lateinit var runButton: TextView
  private lateinit var statusRow: LinearLayout
  private lateinit var statusSpinner: ProgressBar
  private lateinit var statusText: TextView
  private lateinit var answerCard: ScrollView
  private lateinit var answerText: TextView

  private var controllerListener: CesiumAssistantController.Listener? = null

  override fun onCreateContentView(): View {
    val root = FrameLayout(context).apply { setBackgroundColor(CesiumTheme.BACKDROP) }

    val card = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      background = CesiumTheme.topRounded(CesiumTheme.CARD_BG, CesiumTheme.dp(context, 24f).toFloat())
      setPadding(pad(22), pad(12), pad(22), pad(20))
    }

    card.addView(View(context).apply {
      background = CesiumTheme.pill(CesiumTheme.BORDER)
    }, LinearLayout.LayoutParams(pad(36), pad(4)).apply {
      gravity = Gravity.CENTER_HORIZONTAL
      bottomMargin = pad(14)
    })

    // Header: wordmark + minimize + close.
    val header = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
    }
    val heading = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    heading.addView(TextView(context).apply {
      text = "Cesium"
      textSize = 20f
      setTextColor(CesiumTheme.TEXT_PRIMARY)
      typeface = Typeface.create("sans-serif", Typeface.BOLD)
      letterSpacing = -0.01f
    })
    heading.addView(TextView(context).apply {
      text = "On-screen assistant"
      textSize = 12.5f
      setTextColor(CesiumTheme.TEXT_SECONDARY)
      setPadding(0, pad(1), 0, 0)
    })
    header.addView(heading, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    header.addView(pillButton("Minimize", filled = false) { minimize() })
    header.addView(pillButton("Close", filled = false) { hide() }.apply {
      (layoutParams as? LinearLayout.LayoutParams)?.leftMargin = pad(8)
    })
    card.addView(header)

    // Prompt input with mic + send inline.
    val inputRow = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.BOTTOM
      setPadding(0, pad(16), 0, 0)
    }
    requestInput = EditText(context).apply {
      hint = "Ask Cesium, or tap the mic to speak…"
      setHintTextColor(CesiumTheme.TEXT_MUTED)
      setTextColor(CesiumTheme.TEXT_PRIMARY)
      textSize = 15f
      background = CesiumTheme.rounded(
        CesiumTheme.SURFACE, pad(14).toFloat(), CesiumTheme.BORDER, CesiumTheme.dp(context, 1f)
      )
      setPadding(pad(16), pad(14), pad(16), pad(14))
      minLines = 1
      maxLines = 5
      gravity = Gravity.TOP or Gravity.START
      imeOptions = EditorInfo.IME_ACTION_SEND
      setOnEditorActionListener { _, actionId, _ ->
        if (actionId == EditorInfo.IME_ACTION_SEND) { submit(); true } else false
      }
    }
    inputRow.addView(requestInput, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    micButton = circleButton("Mic") { toggleDictation() }
    inputRow.addView(micButton, LinearLayout.LayoutParams(pad(48), pad(48)).apply { leftMargin = pad(10) })
    card.addView(inputRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

    // Action row: Open app + Send.
    val actionRow = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(0, pad(14), 0, 0)
    }
    actionRow.addView(pillButton("Open app", filled = false) { openCesium() })
    actionRow.addView(View(context), LinearLayout.LayoutParams(0, 1, 1f))
    runButton = pillButton("Send  ↑", filled = true) { submit() }
    actionRow.addView(runButton)
    card.addView(actionRow)

    // Status row.
    statusRow = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(0, pad(14), 0, 0)
      visibility = View.GONE
    }
    statusSpinner = ProgressBar(context).apply { isIndeterminate = true; visibility = View.GONE }
    statusText = TextView(context).apply {
      textSize = 13f
      setTextColor(CesiumTheme.STATUS)
    }
    statusRow.addView(statusSpinner, LinearLayout.LayoutParams(pad(16), pad(16)).apply { rightMargin = pad(10) })
    statusRow.addView(statusText)
    card.addView(statusRow)

    // Answer card (Markdown-rendered).
    answerText = TextView(context).apply {
      textSize = 14.5f
      setTextColor(CesiumTheme.TEXT_PRIMARY)
      setTextIsSelectable(true)
      setLineSpacing(pad(3).toFloat(), 1f)
    }
    answerCard = ScrollView(context).apply {
      background = CesiumTheme.rounded(CesiumTheme.SURFACE, pad(14).toFloat())
      setPadding(pad(16), pad(14), pad(16), pad(14))
      visibility = View.GONE
      addView(answerText)
    }
    card.addView(answerCard, LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, pad(210)
    ).apply { topMargin = pad(12) })

    root.addView(card, FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM
    ))
    return root
  }

  override fun onShow(args: Bundle?, showFlags: Int) {
    super.onShow(args, showFlags)
    // Reflect any run still in flight (e.g. re-opened from the bubble).
    if (controllerListener != null) return
    val obs = CesiumAssistantController.Listener { state -> applyState(state) }
    controllerListener = obs
    CesiumAssistantController.addListener(context, obs)
  }

  override fun onHide() {
    controllerListener?.let { CesiumAssistantController.removeListener(it) }
    controllerListener = null
    recorder.cancel()
    super.onHide()
  }

  override fun onHandleAssist(data: Bundle?, structure: AssistStructure?, content: AssistContent?) {
    val parts = mutableListOf<String>()
    content?.webUri?.toString()?.let { parts.add("URL: $it") }
    structure?.let {
      val text = StringBuilder()
      for (windowIndex in 0 until it.windowNodeCount) {
        appendNodeText(it.getWindowNodeAt(windowIndex).rootViewNode, text, 0)
      }
      if (text.isNotBlank()) parts.add("Foreground screen text:\n${text.toString().take(4_000)}")
    }
    assistContext = parts.joinToString("\n")
  }

  override fun onHandleScreenshot(screenshot: Bitmap?) {
    capturedScreenshot = screenshot
  }

  override fun onBackPressed() = hide()

  private fun submit() {
    val request = requestInput.text?.toString()?.trim().orEmpty()
    if (request.isBlank()) {
      showStatus("Type or speak a request first.", spinning = false, color = CesiumTheme.DANGER)
      return
    }
    if (CesiumAssistantController.state.running) {
      showStatus("An agent run is already in progress.", spinning = true, color = CesiumTheme.STATUS)
      return
    }
    answerCard.visibility = View.GONE
    // Attach the screenshot only when the user actually refers to the screen;
    // otherwise the agent can pull it on demand via the phone_screenshot tool.
    val screenshot = capturedScreenshot?.takeIf { referencesScreen(request) }
    CesiumAssistantController.start(context, request, assistContext, screenshot)
  }

  private fun referencesScreen(prompt: String): Boolean {
    val p = prompt.lowercase()
    return listOf(
      "screen", "screenshot", "this ", "here", "see ", "look", "image", "photo",
      "picture", "on display", "what's shown", "whats shown", "visible", "reading",
      "read this", "current app", "in front"
    ).any { p.contains(it) }
  }

  private fun toggleDictation() {
    if (recorder.isRecording) {
      micButton.text = "…"
      recorder.stopAndTranscribe { text, error ->
        micButton.text = "Mic"
        setMicActive(false)
        if (text != null) {
          val existing = requestInput.text?.toString()?.trim().orEmpty()
          val merged = if (existing.isBlank()) text else "$existing $text"
          requestInput.setText(merged)
          requestInput.setSelection(merged.length)
        } else if (error != null) {
          showStatus(error, spinning = false, color = CesiumTheme.DANGER)
        }
      }
      return
    }
    if (!hasMicPermission()) {
      showStatus("Grant microphone access to Cesium, then tap the mic again.", spinning = false, color = CesiumTheme.DANGER)
      requestMicPermission()
      return
    }
    if (recorder.start()) {
      setMicActive(true)
      micButton.text = "Stop"
      showStatus("Listening… tap Stop when done.", spinning = false, color = CesiumTheme.STATUS)
    } else {
      showStatus("Couldn't start recording.", spinning = false, color = CesiumTheme.DANGER)
    }
  }

  private fun setMicActive(active: Boolean) {
    micButton.background = CesiumTheme.pill(
      if (active) CesiumTheme.DANGER else CesiumTheme.SURFACE,
      CesiumTheme.BORDER, CesiumTheme.dp(context, 1f)
    )
    micButton.setTextColor(if (active) CesiumTheme.ACCENT_TEXT else CesiumTheme.TEXT_SECONDARY)
  }

  private fun hasMicPermission(): Boolean =
    context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

  private fun requestMicPermission() {
    runCatching {
      context.startActivity(
        Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
          .setData(android.net.Uri.parse("package:${context.packageName}"))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      )
    }
  }

  private fun minimize() {
    if (!CesiumAssistantBubble.canOverlay(context)) {
      showStatus("Allow Cesium to display over other apps, then Minimize again.", spinning = false, color = CesiumTheme.DANGER)
      CesiumAssistantBubble.requestOverlayPermission(context)
      return
    }
    CesiumAssistantBubble.show(context)
    hide()
  }

  private fun applyState(state: CesiumAssistantController.State) {
    if (!::statusText.isInitialized) return
    if (state.status.isNotBlank()) {
      val color = when { state.ok -> CesiumTheme.SUCCESS; state.terminal -> CesiumTheme.DANGER; else -> CesiumTheme.STATUS }
      showStatus(state.status, spinning = state.running, color = color)
    }
    runButton.isEnabled = !state.running
    runButton.alpha = if (state.running) 0.55f else 1f
    if (state.answer.isNotBlank()) {
      answerText.text = Markdown.render(state.answer)
      answerCard.visibility = View.VISIBLE
    }
  }

  private fun showStatus(text: String, spinning: Boolean, color: Int) {
    statusRow.visibility = View.VISIBLE
    statusSpinner.visibility = if (spinning) View.VISIBLE else View.GONE
    statusText.text = text
    statusText.setTextColor(color)
  }

  private fun openCesium() {
    context.startActivity(Intent(context, MainActivity::class.java).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    })
    hide()
  }

  private fun circleButton(label: String, onClick: () -> Unit): TextView =
    TextView(context).apply {
      text = label
      textSize = 12f
      gravity = Gravity.CENTER
      typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
      setTextColor(CesiumTheme.TEXT_SECONDARY)
      background = CesiumTheme.pill(CesiumTheme.SURFACE, CesiumTheme.BORDER, CesiumTheme.dp(context, 1f))
      isClickable = true
      setOnClickListener { onClick() }
    }

  private fun pillButton(label: String, filled: Boolean, onClick: () -> Unit): TextView =
    TextView(context).apply {
      text = label
      textSize = 14f
      typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
      gravity = Gravity.CENTER
      setPadding(pad(18), pad(11), pad(18), pad(11))
      if (filled) {
        setTextColor(CesiumTheme.ACCENT_TEXT)
        background = CesiumTheme.pill(CesiumTheme.ACCENT)
      } else {
        setTextColor(CesiumTheme.TEXT_SECONDARY)
        background = CesiumTheme.pill(CesiumTheme.SURFACE, CesiumTheme.BORDER, CesiumTheme.dp(context, 1f))
      }
      isClickable = true
      setOnClickListener { onClick() }
    }

  private fun appendNodeText(node: AssistStructure.ViewNode, output: StringBuilder, depth: Int) {
    if (output.length >= 4_000 || depth > 40) return
    val text = node.text?.toString()?.trim().orEmpty()
    val description = node.contentDescription?.toString()?.trim().orEmpty()
    val value = listOf(text, description).filter { it.isNotBlank() }.distinct().joinToString(" · ")
    if (value.isNotBlank()) output.append(value).append('\n')
    for (index in 0 until node.childCount) {
      appendNodeText(node.getChildAt(index), output, depth + 1)
    }
  }

  private fun pad(value: Int): Int = CesiumTheme.dp(context, value.toFloat())
}

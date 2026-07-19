package com.cesium.mobile.assistant

import android.app.assist.AssistContent
import android.app.assist.AssistStructure
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Typeface
import android.os.Bundle
import android.service.voice.VoiceInteractionSession
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import com.cesium.mobile.MainActivity

/**
 * Cesium's system-assistant surface. Rendered with the shared Cesium Design 2
 * dark tokens (CesiumTheme) so the overlay reads as part of the product rather
 * than a stock Android dialog. It collects the current screen's semantic
 * context plus an auto-attached screenshot (for multimodal models) and hands a
 * request to a connected Cesium server agent, streaming status back inline.
 */
class CesiumVoiceInteractionSession(context: Context) : VoiceInteractionSession(context) {
  private val assistantClient = CesiumAssistantClient(context)
  private var assistContext = ""
  private var capturedScreenshot: Bitmap? = null
  private var attachScreenshot = true
  private var running = false

  private lateinit var requestInput: EditText
  private lateinit var contextChip: TextView
  private lateinit var screenshotChip: TextView
  private lateinit var statusRow: LinearLayout
  private lateinit var statusSpinner: ProgressBar
  private lateinit var statusText: TextView
  private lateinit var answerCard: ScrollView
  private lateinit var answerText: TextView
  private lateinit var runButton: TextView

  private val suggestions = listOf(
    "Create a cron job that appends the date to ~/cesium-cron.log every minute, then confirm the exact line",
    "Summarize what is on this screen in one line",
    "Search the web for the latest Bun release version",
    "Open the Settings app"
  )

  override fun onCreateContentView(): View {
    val root = FrameLayout(context).apply { setBackgroundColor(CesiumTheme.BACKDROP) }

    val card = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      background = CesiumTheme.topRounded(CesiumTheme.CARD_BG, CesiumTheme.dp(context, 24f).toFloat())
      setPadding(pad(22), pad(12), pad(22), pad(20))
    }

    // Grabber handle.
    card.addView(View(context).apply {
      background = CesiumTheme.pill(CesiumTheme.BORDER)
    }, LinearLayout.LayoutParams(pad(36), pad(4)).apply {
      gravity = Gravity.CENTER_HORIZONTAL
      bottomMargin = pad(14)
    })

    // Header: wordmark + close.
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
    header.addView(pillButton("Close", filled = false) { hide() })
    card.addView(header)

    // Context chips row.
    val chipRow = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      setPadding(0, pad(14), 0, pad(12))
    }
    contextChip = statusChip("Reading screen…", CesiumTheme.STATUS)
    screenshotChip = statusChip("Screenshot ready", CesiumTheme.TEXT_SECONDARY).apply {
      setOnClickListener { toggleScreenshot() }
    }
    chipRow.addView(contextChip)
    chipRow.addView(screenshotChip, LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
    ).apply { leftMargin = pad(8) })
    card.addView(chipRow)

    // Prompt input.
    requestInput = EditText(context).apply {
      hint = "Ask Cesium to do something with this screen…"
      setHintTextColor(CesiumTheme.TEXT_MUTED)
      setTextColor(CesiumTheme.TEXT_PRIMARY)
      textSize = 15f
      background = CesiumTheme.rounded(
        CesiumTheme.SURFACE, pad(14).toFloat(), CesiumTheme.BORDER, CesiumTheme.dp(context, 1f)
      )
      setPadding(pad(16), pad(14), pad(16), pad(14))
      minLines = 2
      maxLines = 5
      gravity = Gravity.TOP or Gravity.START
      imeOptions = EditorInfo.IME_ACTION_SEND
      setOnEditorActionListener { _, actionId, _ ->
        if (actionId == EditorInfo.IME_ACTION_SEND) { submit(); true } else false
      }
    }
    card.addView(requestInput, LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
    ))

    // Suggestion chips (tap to prefill + run).
    val suggestScroll = HorizontalScrollView(context).apply {
      isHorizontalScrollBarEnabled = false
      setPadding(0, pad(12), 0, 0)
    }
    val suggestRow = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
    suggestions.forEach { suggestion ->
      suggestRow.addView(suggestionChip(suggestion), LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
      ).apply { rightMargin = pad(8) })
    }
    suggestScroll.addView(suggestRow)
    card.addView(suggestScroll)

    // Action row: helper text + primary run.
    val actionRow = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(0, pad(16), 0, 0)
    }
    actionRow.addView(pillButton("Open app", filled = false) { openCesium() })
    actionRow.addView(View(context), LinearLayout.LayoutParams(0, 1, 1f))
    runButton = pillButton("Run  ↑", filled = true) { submit() }
    actionRow.addView(runButton)
    card.addView(actionRow)

    // Status row.
    statusRow = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(0, pad(14), 0, 0)
      visibility = View.GONE
    }
    statusSpinner = ProgressBar(context).apply {
      isIndeterminate = true
      visibility = View.GONE
    }
    statusText = TextView(context).apply {
      textSize = 13f
      setTextColor(CesiumTheme.STATUS)
    }
    statusRow.addView(statusSpinner, LinearLayout.LayoutParams(pad(16), pad(16)).apply {
      rightMargin = pad(10)
    })
    statusRow.addView(statusText)
    card.addView(statusRow)

    // Answer card.
    answerText = TextView(context).apply {
      textSize = 14.5f
      setTextColor(CesiumTheme.TEXT_PRIMARY)
      setLineSpacing(pad(3).toFloat(), 1f)
    }
    answerCard = ScrollView(context).apply {
      background = CesiumTheme.rounded(CesiumTheme.SURFACE, pad(14).toFloat())
      setPadding(pad(16), pad(14), pad(16), pad(14))
      visibility = View.GONE
      addView(answerText)
    }
    card.addView(answerCard, LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, pad(190)
    ).apply { topMargin = pad(12) })

    root.addView(card, FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM
    ))
    refreshChips()
    return root
  }

  override fun onHandleAssist(
    data: Bundle?,
    structure: AssistStructure?,
    content: AssistContent?
  ) {
    val parts = mutableListOf<String>()
    content?.webUri?.toString()?.let { parts.add("URL: $it") }
    content?.structuredData?.takeIf { it.isNotBlank() }?.let {
      parts.add("Structured content: ${it.take(4_000)}")
    }
    structure?.let {
      val text = StringBuilder()
      for (windowIndex in 0 until it.windowNodeCount) {
        appendNodeText(it.getWindowNodeAt(windowIndex).rootViewNode, text, 0)
      }
      if (text.isNotBlank()) parts.add("Visible interface:\n${text.toString().take(8_000)}")
    }
    assistContext = parts.joinToString("\n")
    refreshChips()
  }

  override fun onHandleScreenshot(screenshot: Bitmap?) {
    capturedScreenshot = screenshot
    refreshChips()
  }

  override fun onBackPressed() = hide()

  private fun submit() {
    if (running) return
    val request = requestInput.text?.toString()?.trim().orEmpty()
    if (request.isBlank()) {
      showStatus("Type a request first.", spinning = false, color = CesiumTheme.DANGER)
      return
    }
    running = true
    requestInput.isEnabled = false
    runButton.isEnabled = false
    runButton.alpha = 0.55f
    answerCard.visibility = View.GONE
    showStatus("Starting agent…", spinning = true, color = CesiumTheme.STATUS)
    assistantClient.createAgent(
      request,
      assistContext,
      capturedScreenshot?.takeIf { attachScreenshot }
    ) { status, answer ->
      val terminal = status == "Done" ||
        status.startsWith("Agent failed") ||
        status.startsWith("Agent cancelled") ||
        status.startsWith("Could not reach") ||
        status.startsWith("Server returned")
      val color = when {
        status == "Done" -> CesiumTheme.SUCCESS
        terminal -> CesiumTheme.DANGER
        else -> CesiumTheme.STATUS
      }
      showStatus(status, spinning = !terminal, color = color)
      if (!answer.isNullOrBlank()) {
        answerText.text = answer
        answerCard.visibility = View.VISIBLE
      }
      if (terminal) {
        running = false
        requestInput.isEnabled = true
        runButton.isEnabled = true
        runButton.alpha = 1f
      }
    }
  }

  private fun toggleScreenshot() {
    if (capturedScreenshot == null) return
    attachScreenshot = !attachScreenshot
    refreshChips()
  }

  private fun refreshChips() {
    if (!::contextChip.isInitialized) return
    val hasContext = assistContext.isNotBlank()
    contextChip.text = if (hasContext) "Screen context ready" else "No screen context"
    setChipColor(contextChip, if (hasContext) CesiumTheme.STATUS else CesiumTheme.TEXT_MUTED)

    val hasShot = capturedScreenshot != null
    screenshotChip.visibility = if (hasShot) View.VISIBLE else View.GONE
    if (hasShot) {
      screenshotChip.text = if (attachScreenshot) "Screenshot attached" else "Screenshot off"
      setChipColor(
        screenshotChip,
        if (attachScreenshot) CesiumTheme.SUCCESS else CesiumTheme.TEXT_MUTED
      )
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

  private fun statusChip(label: String, color: Int): TextView =
    TextView(context).apply {
      text = label
      textSize = 11.5f
      setTextColor(color)
      typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
      background = CesiumTheme.pill(CesiumTheme.SURFACE_RAISED)
      setPadding(pad(12), pad(6), pad(12), pad(6))
    }

  private fun setChipColor(chip: TextView, color: Int) = chip.setTextColor(color)

  private fun suggestionChip(text: String): TextView =
    TextView(context).apply {
      this.text = text
      textSize = 12.5f
      setTextColor(CesiumTheme.TEXT_SECONDARY)
      maxLines = 1
      ellipsize = TextUtils.TruncateAt.END
      background = CesiumTheme.pill(
        CesiumTheme.SURFACE, CesiumTheme.BORDER, CesiumTheme.dp(context, 1f)
      )
      setPadding(pad(14), pad(9), pad(14), pad(9))
      setOnClickListener {
        requestInput.setText(text)
        requestInput.setSelection(text.length)
        submit()
      }
    }

  private fun pillButton(label: String, filled: Boolean, onClick: () -> Unit): TextView =
    TextView(context).apply {
      text = label
      textSize = 14f
      typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
      gravity = Gravity.CENTER
      setPadding(pad(20), pad(11), pad(20), pad(11))
      if (filled) {
        setTextColor(CesiumTheme.ACCENT_TEXT)
        background = CesiumTheme.pill(CesiumTheme.ACCENT)
      } else {
        setTextColor(CesiumTheme.TEXT_SECONDARY)
        background = CesiumTheme.pill(
          CesiumTheme.SURFACE, CesiumTheme.BORDER, CesiumTheme.dp(context, 1f)
        )
      }
      isClickable = true
      setOnClickListener { onClick() }
    }

  private fun appendNodeText(
    node: AssistStructure.ViewNode,
    output: StringBuilder,
    depth: Int
  ) {
    if (output.length >= 8_000 || depth > 40) return
    val text = node.text?.toString()?.trim().orEmpty()
    val description = node.contentDescription?.toString()?.trim().orEmpty()
    val hint = node.hint?.trim().orEmpty()
    val value = listOf(text, description, hint)
      .filter { it.isNotBlank() }
      .distinct()
      .joinToString(" · ")
    if (value.isNotBlank()) output.append(value).append('\n')
    for (index in 0 until node.childCount) {
      appendNodeText(node.getChildAt(index), output, depth + 1)
    }
  }

  private fun pad(value: Int): Int = CesiumTheme.dp(context, value.toFloat())
}

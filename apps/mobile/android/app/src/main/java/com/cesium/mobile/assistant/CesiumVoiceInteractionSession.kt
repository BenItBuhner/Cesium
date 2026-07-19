package com.cesium.mobile.assistant

import android.app.AssistContent
import android.app.AssistStructure
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.service.voice.VoiceInteractionSession
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.cesium.mobile.MainActivity

class CesiumVoiceInteractionSession(context: Context) : VoiceInteractionSession(context) {
  private val assistantClient = CesiumAssistantClient(context)
  private var assistContext = ""
  private var capturedScreenshot: Bitmap? = null
  private lateinit var requestInput: EditText
  private lateinit var includeScreenshot: CheckBox
  private lateinit var statusText: TextView
  private lateinit var answerText: TextView

  override fun onCreateContentView(): View {
    val density = context.resources.displayMetrics.density
    val root = FrameLayout(context).apply {
      setBackgroundColor(Color.argb(72, 0, 0, 0))
    }
    val card = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(22), dp(18), dp(22), dp(22))
      background = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        cornerRadii = floatArrayOf(
          24 * density, 24 * density,
          24 * density, 24 * density,
          0f, 0f,
          0f, 0f
        )
        setColor(Color.rgb(20, 22, 27))
      }
    }
    card.addView(TextView(context).apply {
      text = "Cesium"
      textSize = 22f
      setTextColor(Color.WHITE)
      setTypeface(typeface, android.graphics.Typeface.BOLD)
    })
    card.addView(TextView(context).apply {
      text = "Ask about this screen or start an action"
      textSize = 14f
      setTextColor(Color.rgb(170, 177, 190))
      setPadding(0, dp(4), 0, dp(14))
    })
    requestInput = EditText(context).apply {
      hint = "What should Cesium do?"
      setHintTextColor(Color.rgb(128, 136, 151))
      setTextColor(Color.WHITE)
      setBackgroundColor(Color.rgb(32, 35, 42))
      setPadding(dp(14), dp(12), dp(14), dp(12))
      minLines = 2
      maxLines = 5
    }
    card.addView(
      requestInput,
      LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
      )
    )
    includeScreenshot = CheckBox(context).apply {
      text = "Attach screenshot (multimodal models)"
      setTextColor(Color.rgb(184, 190, 201))
      isChecked = false
      visibility = if (capturedScreenshot == null) View.GONE else View.VISIBLE
    }
    card.addView(includeScreenshot)
    val actions = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.END
      setPadding(0, dp(10), 0, 0)
    }
    actions.addView(Button(context).apply {
      text = "Open app"
      setOnClickListener { openCesium() }
    })
    actions.addView(Button(context).apply {
      text = "Run"
      setOnClickListener { submit() }
    })
    actions.addView(Button(context).apply {
      text = "Close"
      setOnClickListener { hide() }
    })
    card.addView(actions)
    statusText = TextView(context).apply {
      text = "Screen context is ready."
      textSize = 13f
      setTextColor(Color.rgb(145, 207, 255))
      setPadding(0, dp(10), 0, 0)
    }
    card.addView(statusText)
    answerText = TextView(context).apply {
      textSize = 15f
      setTextColor(Color.WHITE)
      setPadding(0, dp(8), 0, 0)
    }
    val scroll = ScrollView(context).apply {
      addView(answerText)
    }
    card.addView(
      scroll,
      LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        dp(180)
      )
    )
    root.addView(
      card,
      FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
        Gravity.BOTTOM
      )
    )
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
    if (::statusText.isInitialized) {
      statusText.text = if (assistContext.isBlank()) {
        "Android did not expose semantic context for this screen."
      } else {
        "Current screen context is ready."
      }
    }
  }

  override fun onHandleScreenshot(screenshot: Bitmap?) {
    capturedScreenshot = screenshot
    if (::includeScreenshot.isInitialized) {
      includeScreenshot.visibility = if (screenshot == null) View.GONE else View.VISIBLE
    }
  }

  override fun onBackPressed() {
    hide()
  }

  private fun submit() {
    val request = requestInput.text?.toString()?.trim().orEmpty()
    if (request.isBlank()) {
      statusText.text = "Type a request first."
      return
    }
    requestInput.isEnabled = false
    assistantClient.createAgent(
      request,
      assistContext,
      capturedScreenshot?.takeIf { includeScreenshot.isChecked }
    ) { status, answer ->
      statusText.text = status
      if (answer != null) {
        answerText.text = answer
      }
      if (status == "Done" || status.startsWith("Agent failed") || status.startsWith("Agent cancelled")) {
        requestInput.isEnabled = true
      }
    }
  }

  private fun openCesium() {
    val intent = Intent(context, MainActivity::class.java).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }
    context.startActivity(intent)
    hide()
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
    if (value.isNotBlank()) {
      output.append(value).append('\n')
    }
    for (index in 0 until node.childCount) {
      appendNodeText(node.getChildAt(index), output, depth + 1)
    }
  }

  private fun dp(value: Int): Int =
    (value * context.resources.displayMetrics.density).toInt()
}

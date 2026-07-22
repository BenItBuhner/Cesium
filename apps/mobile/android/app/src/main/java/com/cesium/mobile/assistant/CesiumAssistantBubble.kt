package com.cesium.mobile.assistant

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.os.Build
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import com.cesium.mobile.MainActivity

/**
 * The "minimize to the corner" surface. A draggable floating overlay window
 * (TYPE_APPLICATION_OVERLAY) that survives leaving the assistant and floats over
 * whatever app is in the foreground, so the agent can keep working in the
 * background while the user does something else. Collapsed it is a small status
 * pill; tapped it expands to a card with the live, Markdown-rendered answer.
 * It observes CesiumAssistantController so status/answer stay in sync.
 */
object CesiumAssistantBubble {
  private var wm: WindowManager? = null
  private var root: FrameLayout? = null
  private var params: WindowManager.LayoutParams? = null
  private var expanded = false
  private var listener: CesiumAssistantController.Listener? = null

  private var pill: LinearLayout? = null
  private var pillSpinner: ProgressBar? = null
  private var pillDot: View? = null
  private var pillText: TextView? = null
  private var cardView: LinearLayout? = null
  private var cardStatus: TextView? = null
  private var cardAnswer: TextView? = null

  fun canOverlay(context: Context): Boolean =
    Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(context)

  fun requestOverlayPermission(context: Context) {
    if (canOverlay(context)) return
    val intent = Intent(
      Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
      android.net.Uri.parse("package:${context.packageName}")
    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { context.startActivity(intent) }
  }

  @SuppressLint("ClickableViewAccessibility")
  fun show(context: Context) {
    val app = context.applicationContext
    if (!canOverlay(app)) {
      requestOverlayPermission(context)
      return
    }
    if (root != null) {
      render(CesiumAssistantController.state)
      return
    }
    val manager = app.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    wm = manager

    val container = FrameLayout(app)
    val lp = WindowManager.LayoutParams(
      WindowManager.LayoutParams.WRAP_CONTENT,
      WindowManager.LayoutParams.WRAP_CONTENT,
      if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
      else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
        WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
      PixelFormat.TRANSLUCENT
    ).apply {
      gravity = Gravity.TOP or Gravity.START
      x = dp(app, 16)
      y = dp(app, 96)
    }
    params = lp

    container.addView(buildPill(app))
    container.addView(buildCard(app).also { it.visibility = View.GONE })
    attachDrag(app, container, lp)
    manager.addView(container, lp)
    root = container

    val obs = CesiumAssistantController.Listener { state ->
      container.post { render(state) }
    }
    listener = obs
    CesiumAssistantController.addListener(app, obs)
    render(CesiumAssistantController.state)
  }

  fun hide() {
    listener?.let { CesiumAssistantController.removeListener(it) }
    listener = null
    root?.let { view -> runCatching { wm?.removeView(view) } }
    root = null
    pill = null; cardView = null; expanded = false
  }

  private fun buildPill(context: Context): LinearLayout {
    val row = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      background = CesiumTheme.pill(CesiumTheme.CARD_BG, CesiumTheme.BORDER, dp(context, 1))
      setPadding(dp(context, 14), dp(context, 10), dp(context, 16), dp(context, 10))
    }
    pillSpinner = ProgressBar(context).apply { isIndeterminate = true }
    pillDot = View(context).apply { background = CesiumTheme.pill(CesiumTheme.SUCCESS) }
    pillText = TextView(context).apply {
      text = "Cesium"
      setTextColor(CesiumTheme.TEXT_PRIMARY)
      textSize = 13f
      typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    }
    row.addView(pillSpinner, LinearLayout.LayoutParams(dp(context, 16), dp(context, 16)).apply {
      rightMargin = dp(context, 10)
    })
    row.addView(pillDot, LinearLayout.LayoutParams(dp(context, 9), dp(context, 9)).apply {
      rightMargin = dp(context, 10)
    })
    row.addView(pillText)
    row.setOnClickListener { toggleExpanded() }
    pill = row
    return row
  }

  private fun buildCard(context: Context): LinearLayout {
    val card = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      background = CesiumTheme.rounded(CesiumTheme.CARD_BG, dp(context, 18).toFloat(), CesiumTheme.BORDER, dp(context, 1))
      setPadding(dp(context, 16), dp(context, 14), dp(context, 16), dp(context, 14))
      layoutParams = FrameLayout.LayoutParams(dp(context, 300), ViewGroup.LayoutParams.WRAP_CONTENT)
    }
    val header = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
    }
    header.addView(TextView(context).apply {
      text = "Cesium"
      setTextColor(CesiumTheme.TEXT_PRIMARY)
      textSize = 15f
      typeface = Typeface.create("sans-serif", Typeface.BOLD)
    }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    header.addView(smallButton(context, "Open") {
      context.startActivity(Intent(context, MainActivity::class.java).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      })
    })
    header.addView(smallButton(context, "Collapse") { toggleExpanded() }.apply {
      (layoutParams as? LinearLayout.LayoutParams)?.leftMargin = dp(context, 8)
    })
    header.addView(smallButton(context, "Close") {
      CesiumAssistantController.reset(); hide()
    }.apply { (layoutParams as? LinearLayout.LayoutParams)?.leftMargin = dp(context, 8) })
    card.addView(header)

    cardStatus = TextView(context).apply {
      textSize = 12f
      setTextColor(CesiumTheme.STATUS)
      setPadding(0, dp(context, 8), 0, dp(context, 8))
    }
    card.addView(cardStatus)

    cardAnswer = TextView(context).apply {
      textSize = 13.5f
      setTextColor(CesiumTheme.TEXT_PRIMARY)
      setLineSpacing(dp(context, 3).toFloat(), 1f)
    }
    val scroll = ScrollView(context).apply {
      background = CesiumTheme.rounded(CesiumTheme.SURFACE, dp(context, 12).toFloat())
      setPadding(dp(context, 12), dp(context, 10), dp(context, 12), dp(context, 10))
      addView(cardAnswer)
    }
    card.addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(context, 240)))
    cardView = card
    return card
  }

  private fun smallButton(context: Context, label: String, onClick: () -> Unit): TextView =
    TextView(context).apply {
      text = label
      textSize = 12f
      setTextColor(CesiumTheme.TEXT_SECONDARY)
      typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
      background = CesiumTheme.pill(CesiumTheme.SURFACE, CesiumTheme.BORDER, dp(context, 1))
      setPadding(dp(context, 12), dp(context, 6), dp(context, 12), dp(context, 6))
      isClickable = true
      setOnClickListener { onClick() }
    }

  private fun toggleExpanded() {
    expanded = !expanded
    pill?.visibility = if (expanded) View.GONE else View.VISIBLE
    cardView?.visibility = if (expanded) View.VISIBLE else View.GONE
    render(CesiumAssistantController.state)
  }

  private fun render(state: CesiumAssistantController.State) {
    val label = when {
      state.running -> "Working…"
      state.ok -> "Done"
      state.terminal -> "Failed"
      else -> "Cesium"
    }
    pillText?.text = label
    pillSpinner?.visibility = if (state.running) View.VISIBLE else View.GONE
    pillDot?.visibility = if (!state.running) View.VISIBLE else View.GONE
    pillDot?.background = CesiumTheme.pill(if (state.ok || !state.terminal) CesiumTheme.SUCCESS else CesiumTheme.DANGER)

    cardStatus?.text = if (state.status.isBlank()) "Idle" else state.status
    cardStatus?.setTextColor(
      when { state.ok -> CesiumTheme.SUCCESS; state.terminal -> CesiumTheme.DANGER; else -> CesiumTheme.STATUS }
    )
    if (state.answer.isNotBlank()) {
      cardAnswer?.text = Markdown.render(state.answer)
    } else {
      cardAnswer?.text = ""
    }
  }

  @SuppressLint("ClickableViewAccessibility")
  private fun attachDrag(context: Context, view: View, lp: WindowManager.LayoutParams) {
    var startX = 0; var startY = 0; var touchX = 0f; var touchY = 0f; var moved = false
    view.setOnTouchListener { _, event ->
      when (event.action) {
        MotionEvent.ACTION_DOWN -> {
          startX = lp.x; startY = lp.y; touchX = event.rawX; touchY = event.rawY; moved = false
          false
        }
        MotionEvent.ACTION_MOVE -> {
          val dx = (event.rawX - touchX).toInt(); val dy = (event.rawY - touchY).toInt()
          if (kotlin.math.abs(dx) > dp(context, 4) || kotlin.math.abs(dy) > dp(context, 4)) moved = true
          lp.x = startX + dx; lp.y = startY + dy
          runCatching { wm?.updateViewLayout(view, lp) }
          moved
        }
        MotionEvent.ACTION_UP -> moved
        else -> false
      }
    }
  }

  private fun dp(context: Context, value: Int): Int = CesiumTheme.dp(context, value.toFloat())
}

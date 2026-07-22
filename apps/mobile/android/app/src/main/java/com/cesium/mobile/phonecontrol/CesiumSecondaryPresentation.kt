package com.cesium.mobile.phonecontrol

import android.app.Presentation
import android.content.Context
import android.graphics.Color
import android.os.Bundle
import android.view.Display
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.TextView

class CesiumSecondaryPresentation(
  context: Context,
  display: Display
) : Presentation(context, display) {
  private lateinit var titleView: TextView
  private lateinit var bodyView: TextView
  private var pendingTitle = "Cesium background workspace"
  private var pendingBody = "Ready for assistant work."

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val density = context.resources.displayMetrics.density
    val root = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(
        (48 * density).toInt(),
        (48 * density).toInt(),
        (48 * density).toInt(),
        (48 * density).toInt()
      )
      setBackgroundColor(Color.rgb(16, 18, 22))
    }
    titleView = TextView(context).apply {
      setTextColor(Color.WHITE)
      textSize = 28f
    }
    bodyView = TextView(context).apply {
      setTextColor(Color.rgb(184, 190, 201))
      textSize = 17f
      setPadding(0, (18 * density).toInt(), 0, 0)
    }
    root.addView(
      titleView,
      LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
      )
    )
    root.addView(
      bodyView,
      LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
      )
    )
    setContentView(root)
    render(pendingTitle, pendingBody)
  }

  fun render(title: String, body: String) {
    pendingTitle = title
    pendingBody = body
    if (::titleView.isInitialized) {
      titleView.text = title
      bodyView.text = body
    }
  }
}

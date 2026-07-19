package com.cesium.mobile.phonecontrol

import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.TextView

class CesiumSecondaryDisplayActivity : Activity() {
  private lateinit var titleView: TextView
  private lateinit var bodyView: TextView

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val density = resources.displayMetrics.density
    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding((48 * density).toInt(), (48 * density).toInt(), (48 * density).toInt(), (48 * density).toInt())
      setBackgroundColor(Color.rgb(16, 18, 22))
    }
    titleView = TextView(this).apply {
      setTextColor(Color.WHITE)
      textSize = 28f
    }
    bodyView = TextView(this).apply {
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
    CesiumSecondaryDisplayController.bind(this)
  }

  fun render(title: String, body: String) {
    runOnUiThread {
      titleView.text = title
      bodyView.text = body
    }
  }

  override fun onDestroy() {
    CesiumSecondaryDisplayController.unbind(this)
    super.onDestroy()
  }
}

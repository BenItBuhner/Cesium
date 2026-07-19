package com.cesium.mobile.assistant

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable

/**
 * Cesium Design 2 dark tokens mirrored for the native assistant overlay so the
 * system-assistant surface matches the app instead of using default Android
 * widget styling. Canonical source: packages/design/src/theme-tokens.ts.
 */
object CesiumTheme {
  val BACKDROP = Color.argb(153, 0, 0, 0)
  val CARD_BG = Color.parseColor("#1B1B1D")
  val SURFACE = Color.parseColor("#141414")
  val SURFACE_RAISED = Color.parseColor("#242424")
  val BORDER = Color.parseColor("#383838")
  val TEXT_PRIMARY = Color.parseColor("#FFFFFF")
  val TEXT_SECONDARY = Color.parseColor("#9AA0AA")
  val TEXT_MUTED = Color.parseColor("#6F6F6F")
  val ACCENT = Color.parseColor("#FFFFFF")
  val ACCENT_TEXT = Color.parseColor("#141414")
  val ACCENT_SOFT = Color.argb(26, 255, 255, 255)
  val STATUS = Color.parseColor("#8FCBFF")
  val SUCCESS = Color.parseColor("#5E8D6B")
  val DANGER = Color.parseColor("#E59A9A")

  fun dp(context: Context, value: Float): Int =
    (value * context.resources.displayMetrics.density).toInt()

  fun rounded(color: Int, radiusPx: Float, strokeColor: Int? = null, strokePx: Int = 0): GradientDrawable =
    GradientDrawable().apply {
      shape = GradientDrawable.RECTANGLE
      cornerRadius = radiusPx
      setColor(color)
      if (strokeColor != null && strokePx > 0) setStroke(strokePx, strokeColor)
    }

  fun topRounded(color: Int, radiusPx: Float): GradientDrawable =
    GradientDrawable().apply {
      shape = GradientDrawable.RECTANGLE
      cornerRadii = floatArrayOf(radiusPx, radiusPx, radiusPx, radiusPx, 0f, 0f, 0f, 0f)
      setColor(color)
    }

  fun pill(color: Int, strokeColor: Int? = null, strokePx: Int = 0): GradientDrawable =
    GradientDrawable().apply {
      shape = GradientDrawable.RECTANGLE
      cornerRadius = 999f
      setColor(color)
      if (strokeColor != null && strokePx > 0) setStroke(strokePx, strokeColor)
    }
}

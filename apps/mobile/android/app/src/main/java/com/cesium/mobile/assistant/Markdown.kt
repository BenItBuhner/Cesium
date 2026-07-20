package com.cesium.mobile.assistant

import android.graphics.Color
import android.graphics.Typeface
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.BackgroundColorSpan
import android.text.style.BulletSpan
import android.text.style.ForegroundColorSpan
import android.text.style.LeadingMarginSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan

/**
 * Tiny, dependency-free Markdown -> Spanned renderer for the assistant answer
 * card. The agent replies in Markdown; a bare TextView would show the raw
 * asterisks, backticks and fences, which is exactly the "broken formatting"
 * problem. This covers the constructs models actually emit: headings, bold,
 * italic, inline code, fenced/indented code blocks, bullet + numbered lists,
 * blockquotes and links (rendered as their label). It is intentionally forgiving
 * rather than spec-complete.
 */
object Markdown {
  private const val CODE_BG = 0x33FFFFFF
  private val CODE_FG = Color.parseColor("#D6E2FF")

  fun render(source: String): Spanned {
    val out = SpannableStringBuilder()
    val lines = source.replace("\r\n", "\n").split("\n")
    var inFence = false
    val fenceBuffer = StringBuilder()
    var index = 0
    while (index < lines.size) {
      val line = lines[index]
      val fence = line.trimStart().startsWith("```")
      if (fence) {
        if (inFence) {
          appendCodeBlock(out, fenceBuffer.toString().trimEnd('\n'))
          fenceBuffer.setLength(0)
          inFence = false
        } else {
          inFence = true
        }
        index += 1
        continue
      }
      if (inFence) {
        fenceBuffer.append(line).append('\n')
        index += 1
        continue
      }
      appendLine(out, line)
      if (index < lines.size - 1) out.append('\n')
      index += 1
    }
    if (inFence && fenceBuffer.isNotEmpty()) {
      appendCodeBlock(out, fenceBuffer.toString().trimEnd('\n'))
    }
    // Collapse trailing whitespace.
    while (out.isNotEmpty() && out.last() == '\n') out.delete(out.length - 1, out.length)
    return out
  }

  private fun appendLine(out: SpannableStringBuilder, raw: String) {
    val trimmed = raw.trimStart()
    val indent = raw.length - trimmed.length

    // Headings.
    val heading = Regex("^(#{1,6})\\s+(.*)$").find(trimmed)
    if (heading != null) {
      val level = heading.groupValues[1].length
      val start = out.length
      appendInline(out, heading.groupValues[2])
      val end = out.length
      out.setSpan(StyleSpan(Typeface.BOLD), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      val scale = when (level) { 1 -> 1.35f; 2 -> 1.22f; 3 -> 1.12f; else -> 1.05f }
      out.setSpan(RelativeSizeSpan(scale), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      return
    }

    // Blockquote.
    if (trimmed.startsWith(">")) {
      val start = out.length
      appendInline(out, trimmed.removePrefix(">").trimStart())
      out.setSpan(ForegroundColorSpan(Color.parseColor("#9AA0AA")), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      out.setSpan(LeadingMarginSpan.Standard(dpText(14)), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      return
    }

    // Bullet list.
    val bullet = Regex("^[-*+]\\s+(.*)$").find(trimmed)
    if (bullet != null) {
      val start = out.length
      appendInline(out, bullet.groupValues[1])
      out.setSpan(
        BulletSpan(dpText(10), Color.parseColor("#9AA0AA")),
        start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
      )
      out.setSpan(
        LeadingMarginSpan.Standard(dpText(6) + indent * 4),
        start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
      )
      return
    }

    // Numbered list.
    val numbered = Regex("^(\\d+)[.)]\\s+(.*)$").find(trimmed)
    if (numbered != null) {
      out.append("${numbered.groupValues[1]}. ")
      appendInline(out, numbered.groupValues[2])
      return
    }

    // Horizontal rule.
    if (Regex("^([-*_])\\1{2,}$").matches(trimmed)) {
      out.append("──────────")
      out.setSpan(
        ForegroundColorSpan(Color.parseColor("#383838")),
        out.length - 10, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
      )
      return
    }

    appendInline(out, raw)
  }

  private fun appendInline(out: SpannableStringBuilder, text: String) {
    var i = 0
    while (i < text.length) {
      val rest = text.substring(i)
      // Inline code.
      if (rest.startsWith("`")) {
        val close = text.indexOf('`', i + 1)
        if (close > i) {
          val start = out.length
          out.append(text.substring(i + 1, close))
          out.setSpan(TypefaceSpan("monospace"), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
          out.setSpan(BackgroundColorSpan(CODE_BG), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
          out.setSpan(ForegroundColorSpan(CODE_FG), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
          i = close + 1
          continue
        }
      }
      // Bold (** or __).
      val boldMarker = when {
        rest.startsWith("**") -> "**"
        rest.startsWith("__") -> "__"
        else -> null
      }
      if (boldMarker != null) {
        val close = text.indexOf(boldMarker, i + 2)
        if (close > i) {
          val start = out.length
          appendInline(out, text.substring(i + 2, close))
          out.setSpan(StyleSpan(Typeface.BOLD), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
          i = close + 2
          continue
        }
      }
      // Italic (* or _), single marker not part of a bold run.
      if ((rest.startsWith("*") || rest.startsWith("_"))) {
        val marker = rest[0]
        val close = text.indexOf(marker, i + 1)
        if (close > i && close != i + 1) {
          val start = out.length
          appendInline(out, text.substring(i + 1, close))
          out.setSpan(StyleSpan(Typeface.ITALIC), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
          i = close + 1
          continue
        }
      }
      // Links [label](url) -> label.
      if (rest.startsWith("[")) {
        val match = Regex("^\\[([^\\]]+)\\]\\(([^)]+)\\)").find(rest)
        if (match != null) {
          val start = out.length
          out.append(match.groupValues[1])
          out.setSpan(ForegroundColorSpan(Color.parseColor("#8FCBFF")), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
          out.setSpan(StyleSpan(Typeface.NORMAL), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
          i += match.value.length
          continue
        }
      }
      out.append(text[i])
      i += 1
    }
  }

  private fun appendCodeBlock(out: SpannableStringBuilder, code: String) {
    if (out.isNotEmpty() && out.last() != '\n') out.append('\n')
    val start = out.length
    out.append(code)
    val end = out.length
    out.setSpan(TypefaceSpan("monospace"), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    out.setSpan(BackgroundColorSpan(CODE_BG), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    out.setSpan(ForegroundColorSpan(CODE_FG), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    out.setSpan(RelativeSizeSpan(0.92f), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    out.append('\n')
  }

  // Density-independent-ish spacing; the overlay always renders at ~2.6x, and
  // these are only margins/gaps so a fixed factor is fine.
  private fun dpText(value: Int): Int = (value * 2.6f).toInt()

  /** Strip Markdown to a clean string for text-to-speech. */
  fun toSpeech(source: String): String {
    var s = source.replace("\r\n", "\n")
    s = s.replace(Regex("```[\\s\\S]*?```"), " code block ")
    s = s.replace(Regex("`([^`]*)`"), "$1")
    s = s.replace(Regex("\\*\\*([^*]+)\\*\\*"), "$1")
    s = s.replace(Regex("__([^_]+)__"), "$1")
    s = s.replace(Regex("(?m)^#{1,6}\\s+"), "")
    s = s.replace(Regex("(?m)^\\s*[-*+]\\s+"), "")
    s = s.replace(Regex("(?m)^\\s*>\\s?"), "")
    s = s.replace(Regex("\\[([^\\]]+)\\]\\([^)]+\\)"), "$1")
    return s.replace(Regex("\\n{2,}"), ". ").replace(Regex("\\s+"), " ").trim()
  }
}

package com.cesium.mobile.notifications

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CesiumChipPresentationTest {
  private val now = 1_000_000_000_000L

  @Test
  fun todoFractionAlwaysOwnsTheChip() {
    // Regression: ETA countdowns used to hijack the chip and hide the
    // fraction whenever the estimate was two-plus minutes out. Progress
    // text now always wins; there is no countdown code path left.
    val chip = resolveChipPresentation(
      shortText = "3/7",
      startedAt = now - 60_000L,
      ongoing = true
    )
    assertEquals(now - 60_000L, chip.countUpFrom)
    assertEquals("3/7", chip.shortCriticalText)
  }

  @Test
  fun goalPercentKeepsChipText() {
    val chip = resolveChipPresentation(
      shortText = "82%",
      startedAt = now - 60_000L,
      ongoing = true
    )
    assertEquals(now - 60_000L, chip.countUpFrom)
    assertEquals("82%", chip.shortCriticalText)
  }

  @Test
  fun ongoingRunWithoutTextFallsBackToElapsedTimer() {
    val chip = resolveChipPresentation(
      shortText = null,
      startedAt = now - 5_000L,
      ongoing = true
    )
    assertEquals(now - 5_000L, chip.countUpFrom)
    assertNull(chip.shortCriticalText)
  }

  @Test
  fun terminalNotificationKeepsTextWithoutAnyChronometer() {
    val chip = resolveChipPresentation(
      shortText = "Done",
      startedAt = now - 5_000L,
      ongoing = false
    )
    assertNull(chip.countUpFrom)
    assertEquals("Done", chip.shortCriticalText)
  }

  @Test
  fun blankShortTextIsDropped() {
    val chip = resolveChipPresentation(
      shortText = "  ",
      startedAt = 0L,
      ongoing = true
    )
    assertNull(chip.shortCriticalText)
  }
}

class CesiumAgentNotificationTest {
  private val startedAt = 1_000_000_000_000L
  private val completedAt = startedAt + 17 * 60_000L + 23_000L

  @Test
  fun expandedBodyListsEveryAgentAndFallsBackToTheCollapsedLine() {
    val list = "• Star Trek Fable 5.1 · Writing\n• Market replay engine · Finishing · 3/4"
    assertEquals(list, resolveExpandedText("1 finishing · 1 writing", list))
    // Older payloads without an expanded body still expand to something.
    assertEquals("Working", resolveExpandedText("Working", null))
    assertEquals("Working", resolveExpandedText("Working", "   "))
  }

  @Test
  fun completionCardsAreStampedWithTheRunEnd() {
    assertEquals(completedAt, resolveNotificationWhen(startedAt, completedAt, ongoing = false))
    // Live notifications keep the start (the chronometer anchor).
    assertEquals(startedAt, resolveNotificationWhen(startedAt, completedAt, ongoing = true))
    // A card without a known end falls back to the start rather than 1970.
    assertEquals(startedAt, resolveNotificationWhen(startedAt, 0L, ongoing = false))
  }

  @Test
  fun completionCardsNameTheirOutcomeInTheHeader() {
    assertEquals(
      "Finished",
      resolveHeaderSubText(subText = "Finished", shortText = "DONE", ongoing = false, sdkInt = 36)
    )
    assertEquals(
      "Failed",
      resolveHeaderSubText(subText = "Failed", shortText = "ERR", ongoing = false, sdkInt = 31)
    )
  }

  @Test
  fun liveNotificationsShowProgressInTheHeaderOnlyWithoutAStatusBarChip() {
    // Pre-16 has no chip, so the header carries the fraction.
    assertEquals(
      "3/7",
      resolveHeaderSubText(subText = null, shortText = "3/7", ongoing = true, sdkInt = 35)
    )
    // Android 16+ puts it in the chip and keeps the header clean.
    assertNull(resolveHeaderSubText(subText = null, shortText = "3/7", ongoing = true, sdkInt = 36))
    assertNull(resolveHeaderSubText(subText = " ", shortText = null, ongoing = true, sdkInt = 35))
  }

  @Test
  fun onlyWebUrlsGetAViewPrAction() {
    assertTrue(isOpenableHttpUrl("https://github.com/acme/app/pull/41"))
    assertTrue(isOpenableHttpUrl(" HTTP://gitlab.example/acme/app/-/merge_requests/2 "))
    assertFalse(isOpenableHttpUrl("intent://scan/#Intent;scheme=zxing;end"))
    assertFalse(isOpenableHttpUrl("file:///etc/passwd"))
    assertFalse(isOpenableHttpUrl(""))
    assertFalse(isOpenableHttpUrl(null))
  }
}

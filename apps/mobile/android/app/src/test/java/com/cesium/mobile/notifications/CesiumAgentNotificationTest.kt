package com.cesium.mobile.notifications

import com.cesium.shared.generated.CesiumDesignTokens
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
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
  @Test
  fun progressColorsFollowCurrentSystemTheme() {
    val light = resolveCesiumProgressColors(false)
    val dark = resolveCesiumProgressColors(true)

    assertEquals(CesiumDesignTokens.Light.AskAccent.toInt(), light.completed)
    assertEquals(CesiumDesignTokens.Light.WorkflowAccent.toInt(), light.active)
    assertEquals(CesiumDesignTokens.Light.TextSecondary.toInt(), light.pending)
    assertEquals(CesiumDesignTokens.Light.GoalAccent.toInt(), light.goal)

    assertEquals(CesiumDesignTokens.Dark.AskAccent.toInt(), dark.completed)
    assertEquals(CesiumDesignTokens.Dark.WorkflowAccent.toInt(), dark.active)
    assertEquals(CesiumDesignTokens.Dark.TextSecondary.toInt(), dark.pending)
    assertEquals(CesiumDesignTokens.Dark.GoalAccent.toInt(), dark.goal)

    assertNotEquals(light.completed, dark.completed)
    assertNotEquals(light.active, dark.active)
  }
}

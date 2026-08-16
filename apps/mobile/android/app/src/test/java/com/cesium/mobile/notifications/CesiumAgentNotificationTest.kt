package com.cesium.mobile.notifications

import com.cesium.shared.generated.CesiumDesignTokens
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CesiumChipPresentationTest {
  private val now = 1_000_000_000_000L

  @Test
  fun farEtaCountdownOwnsTheChipAndSuppressesText() {
    val chip = resolveChipPresentation(
      shortText = "3/7",
      startedAt = now - 60_000L,
      estimatedCompletionAt = now + MIN_COUNTDOWN_MS,
      ongoing = true,
      now = now
    )
    assertEquals(now + MIN_COUNTDOWN_MS, chip.countdownTo)
    assertNull(chip.countUpFrom)
    assertNull(chip.shortCriticalText)
  }

  @Test
  fun nearEtaKeepsChipTextInsteadOfGoingBlank() {
    // Regression: an ETA below the countdown floor used to suppress the
    // short critical text too, leaving an icon-only status chip.
    val chip = resolveChipPresentation(
      shortText = "82%",
      startedAt = now - 60_000L,
      estimatedCompletionAt = now + 30_000L,
      ongoing = true,
      now = now
    )
    assertNull(chip.countdownTo)
    assertEquals(now - 60_000L, chip.countUpFrom)
    assertEquals("82%", chip.shortCriticalText)
  }

  @Test
  fun ongoingRunWithoutEtaShowsElapsedTimeAndText() {
    val chip = resolveChipPresentation(
      shortText = "2/5",
      startedAt = now - 5_000L,
      estimatedCompletionAt = 0L,
      ongoing = true,
      now = now
    )
    assertNull(chip.countdownTo)
    assertEquals(now - 5_000L, chip.countUpFrom)
    assertEquals("2/5", chip.shortCriticalText)
  }

  @Test
  fun terminalNotificationKeepsTextWithoutAnyChronometer() {
    val chip = resolveChipPresentation(
      shortText = "Done",
      startedAt = now - 5_000L,
      estimatedCompletionAt = 0L,
      ongoing = false,
      now = now
    )
    assertNull(chip.countdownTo)
    assertNull(chip.countUpFrom)
    assertEquals("Done", chip.shortCriticalText)
  }

  @Test
  fun blankShortTextIsDropped() {
    val chip = resolveChipPresentation(
      shortText = "  ",
      startedAt = 0L,
      estimatedCompletionAt = 0L,
      ongoing = true,
      now = now
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

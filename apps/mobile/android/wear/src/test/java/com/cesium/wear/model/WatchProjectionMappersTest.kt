package com.cesium.wear.model

import org.junit.Assert.assertEquals
import org.junit.Test

class WatchProjectionMappersTest {
  @Test
  fun mapsStatusesToCompactChips() {
    assertEquals("RUN", statusChip("running"))
    assertEquals("INPUT", statusChip("awaiting_question"))
    assertEquals("INPUT", statusChip("awaiting_permission"))
    assertEquals("DONE", statusChip("completed"))
    assertEquals("ERR", statusChip("failed"))
    assertEquals("PAUSE", statusChip("paused"))
  }

  @Test
  fun includesInterventionAndControlActions() {
    assertEquals(
      listOf("open", "answer_question", "pause", "cancel", "open_on_phone"),
      availableWatchActions("awaiting_question", WatchPendingIntervention.QUESTION)
    )
    assertEquals(
      listOf("open", "resume", "cancel", "open_on_phone"),
      availableWatchActions("paused", null)
    )
  }
}

package com.cesium.shared.contracts

import com.cesium.shared.generated.CesiumCapabilities
import com.cesium.shared.generated.CesiumDataLayerPaths
import com.cesium.shared.generated.CesiumWatchSchema
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SharedContractsTest {
  @Test
  fun generatedContractMatchesWearWireProtocol() {
    assertEquals(WATCH_SCHEMA_VERSION, CesiumWatchSchema.VERSION)
    assertEquals("cesium_phone_relay", CesiumCapabilities.PHONE_RELAY)
    assertEquals("/cesium/projection/current", CesiumDataLayerPaths.CURRENT_PROJECTION)
    assertEquals(
      "/cesium/action/answer_question",
      CesiumDataLayerPaths.actionPath("answer_question")
    )
    assertEquals(
      "answer_question",
      CesiumDataLayerPaths.actionForPath("/cesium/action/answer_question")
    )
    assertTrue("cancel" in CesiumWatchSchema.ACTIONS)
  }

  @Test
  fun projectionRulesAreSharedAcrossWearSurfaces() {
    assertEquals("INPUT", statusChip("awaiting_question"))
    assertEquals("PAUSE", statusChip("paused"))
    assertEquals(
      listOf("open", "pause", "cancel", "open_on_phone"),
      availableWatchActions("running", null)
    )
    assertEquals(45_000L, staleWindowMillis("running"))
  }
}

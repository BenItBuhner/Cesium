package com.cesium.wear.sync

import com.cesium.wear.model.WatchAgentProjection
import com.cesium.wear.model.WatchAgentSyncEnvelope
import com.cesium.wear.model.WatchConnectionSource
import org.junit.Assert.assertEquals
import org.junit.Test

class ConnectionModeResolverTest {
  @Test
  fun prefersDirectWhenConfiguredInAutoMode() {
    assertEquals(
      WatchConnectionMode.DIRECT_SERVER,
      resolveConnectionMode(
        envelope = null,
        preference = "auto",
        phoneRelayReachable = true,
        directConfigured = true
      )
    )
  }

  @Test
  fun usesFreshPhoneProjectionWhenDirectIsUnavailable() {
    assertEquals(
      WatchConnectionMode.PHONE_COMPANION,
      resolveConnectionMode(
        envelope = WatchAgentSyncEnvelope(projection = projection(staleAt = 20_000)),
        preference = "auto",
        phoneRelayReachable = true,
        directConfigured = false,
        now = 10_000
      )
    )
  }

  @Test
  fun fallsBackToCacheForStaleProjection() {
    assertEquals(
      WatchConnectionMode.CACHE,
      resolveConnectionMode(
        envelope = WatchAgentSyncEnvelope(projection = projection(staleAt = 5_000)),
        preference = "auto",
        phoneRelayReachable = false,
        directConfigured = false,
        now = 10_000
      )
    )
  }

  private fun projection(staleAt: Long) =
    WatchAgentProjection(
      workspaceId = "w1",
      conversationId = "c1",
      title = "Agent",
      status = "running",
      chip = "RUN",
      currentActivity = "Working",
      source = WatchConnectionSource.PHONE_COMPANION,
      staleAt = staleAt
    )
}

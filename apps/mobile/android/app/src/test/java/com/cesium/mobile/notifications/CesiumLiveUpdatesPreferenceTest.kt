package com.cesium.mobile.notifications

import org.junit.Assert.assertEquals
import org.junit.Test

class CesiumLiveUpdatesPreferenceTest {
  @Test
  fun nowBarIsTheDefaultAndUnknownValuesNormalizeToIt() {
    assertEquals(LIVE_UPDATE_PREFERENCE_NOW_BAR, normalizeLiveUpdatePreference(null))
    assertEquals(LIVE_UPDATE_PREFERENCE_NOW_BAR, normalizeLiveUpdatePreference(""))
    assertEquals(LIVE_UPDATE_PREFERENCE_NOW_BAR, normalizeLiveUpdatePreference("unexpected"))
  }

  @Test
  fun supportedPreferencesRoundTripUnchanged() {
    assertEquals(
      LIVE_UPDATE_PREFERENCE_NOW_BAR,
      normalizeLiveUpdatePreference(LIVE_UPDATE_PREFERENCE_NOW_BAR)
    )
    assertEquals(
      LIVE_UPDATE_PREFERENCE_LIVE,
      normalizeLiveUpdatePreference(LIVE_UPDATE_PREFERENCE_LIVE)
    )
    assertEquals(
      LIVE_UPDATE_PREFERENCE_OFF,
      normalizeLiveUpdatePreference(LIVE_UPDATE_PREFERENCE_OFF)
    )
  }
}

package com.cesium.mobile.notifications

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CesiumPromotionCapabilityTest {
  @Test
  fun baseAndroid16CannotRenderPromotedUpdates() {
    // 36.0 ships the APIs without the system UI that renders them.
    assertFalse(isPromotionRenderCapable(36, hasMinorSdkAboveBase = false, samsung = false))
  }

  @Test
  fun android16Qpr1AndLaterRenderPromotedUpdates() {
    assertTrue(isPromotionRenderCapable(36, hasMinorSdkAboveBase = true, samsung = false))
    assertTrue(isPromotionRenderCapable(37, hasMinorSdkAboveBase = false, samsung = false))
  }

  @Test
  fun samsungOneUi8RendersInTheNowBarOnBase36() {
    assertTrue(isPromotionRenderCapable(36, hasMinorSdkAboveBase = false, samsung = true))
  }

  @Test
  fun olderAndroidNeverRendersPromotedUpdates() {
    assertFalse(isPromotionRenderCapable(35, hasMinorSdkAboveBase = false, samsung = true))
  }

  @Test
  fun samsungDetectionIsCaseAndWhitespaceInsensitive() {
    assertTrue(isSamsungDevice("samsung"))
    assertTrue(isSamsungDevice("Samsung"))
    assertTrue(isSamsungDevice(" SAMSUNG "))
    assertFalse(isSamsungDevice("google"))
    assertFalse(isSamsungDevice(null))
  }
}

class CesiumLiveUpdatesPreferenceTest {
  @Test
  fun liveUpdatesAreTheDefaultAndUnknownValuesNormalizeToThem() {
    assertEquals(LIVE_UPDATE_PREFERENCE_LIVE, normalizeLiveUpdatePreference(null))
    assertEquals(LIVE_UPDATE_PREFERENCE_LIVE, normalizeLiveUpdatePreference(""))
    assertEquals(LIVE_UPDATE_PREFERENCE_LIVE, normalizeLiveUpdatePreference("unexpected"))
  }

  @Test
  fun supportedPreferencesRoundTripUnchanged() {
    assertEquals(
      LIVE_UPDATE_PREFERENCE_LIVE,
      normalizeLiveUpdatePreference(LIVE_UPDATE_PREFERENCE_LIVE)
    )
    assertEquals(
      LIVE_UPDATE_PREFERENCE_BASIC,
      normalizeLiveUpdatePreference(LIVE_UPDATE_PREFERENCE_BASIC)
    )
    assertEquals(
      LIVE_UPDATE_PREFERENCE_OFF,
      normalizeLiveUpdatePreference(LIVE_UPDATE_PREFERENCE_OFF)
    )
  }

  @Test
  fun legacyNowBarValueNormalizesToLiveUpdates() {
    assertEquals(
      LIVE_UPDATE_PREFERENCE_LIVE,
      normalizeLiveUpdatePreference(LEGACY_LIVE_UPDATE_PREFERENCE_NOW_BAR)
    )
  }

  @Test
  fun alertModesNormalizeToTheirCategoryDefaults() {
    // Completions default to background-only so in-app finishes stay quiet.
    assertEquals(ALERT_MODE_BACKGROUND, normalizeAlertMode(null, DEFAULT_COMPLETION_ALERT_MODE))
    assertEquals(ALERT_MODE_BACKGROUND, normalizeAlertMode("bogus", DEFAULT_COMPLETION_ALERT_MODE))
    // Needs-input alerts default to always.
    assertEquals(ALERT_MODE_ALWAYS, normalizeAlertMode(null, DEFAULT_INTERVENTION_ALERT_MODE))
    // Valid values round-trip unchanged.
    assertEquals(ALERT_MODE_ALWAYS, normalizeAlertMode(ALERT_MODE_ALWAYS, DEFAULT_COMPLETION_ALERT_MODE))
    assertEquals(ALERT_MODE_BACKGROUND, normalizeAlertMode(ALERT_MODE_BACKGROUND, DEFAULT_INTERVENTION_ALERT_MODE))
    assertEquals(ALERT_MODE_OFF, normalizeAlertMode(ALERT_MODE_OFF, DEFAULT_COMPLETION_ALERT_MODE))
  }

  @Test
  fun etaModeDefaultsToGoalOnlyAndUnknownValuesNormalizeToIt() {
    // Todo estimates are noise; only goal runs surface an ETA by default.
    assertEquals(ETA_MODE_GOAL, normalizeEtaMode(null))
    assertEquals(ETA_MODE_GOAL, normalizeEtaMode(""))
    assertEquals(ETA_MODE_GOAL, normalizeEtaMode("bogus"))
    assertEquals(ETA_MODE_GOAL, normalizeEtaMode(ETA_MODE_GOAL))
    assertEquals(ETA_MODE_ALWAYS, normalizeEtaMode(ETA_MODE_ALWAYS))
    assertEquals(ETA_MODE_OFF, normalizeEtaMode(ETA_MODE_OFF))
  }

  @Test
  fun multiAgentModeDefaultsToSeparateNotifications() {
    assertEquals(MULTI_AGENT_SEPARATE, normalizeMultiAgentMode(null))
    assertEquals(MULTI_AGENT_SEPARATE, normalizeMultiAgentMode("bogus"))
    assertEquals(MULTI_AGENT_SEPARATE, normalizeMultiAgentMode(MULTI_AGENT_SEPARATE))
    assertEquals(MULTI_AGENT_COMBINED, normalizeMultiAgentMode(MULTI_AGENT_COMBINED))
  }

  @Test
  fun legacyStoredValuesMigrateWithoutFlippingUserIntent() {
    // Old "nowbar" requested promotion with fallback - that is now "live".
    assertEquals(
      LIVE_UPDATE_PREFERENCE_LIVE,
      migrateLegacyLiveUpdatePreference(LEGACY_LIVE_UPDATE_PREFERENCE_NOW_BAR)
    )
    // Old "live" opted out of promotion - that is now "basic".
    assertEquals(
      LIVE_UPDATE_PREFERENCE_BASIC,
      migrateLegacyLiveUpdatePreference("live")
    )
    assertEquals(
      LIVE_UPDATE_PREFERENCE_OFF,
      migrateLegacyLiveUpdatePreference(LIVE_UPDATE_PREFERENCE_OFF)
    )
    assertNull(migrateLegacyLiveUpdatePreference(null))
    assertNull(migrateLegacyLiveUpdatePreference("unexpected"))
  }
}

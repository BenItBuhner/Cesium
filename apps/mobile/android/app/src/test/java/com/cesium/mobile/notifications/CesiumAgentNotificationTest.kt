package com.cesium.mobile.notifications

import com.cesium.shared.generated.CesiumDesignTokens
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class CesiumAgentNotificationTest {
  @Test
  fun progressColorsFollowCurrentSystemTheme() {
    val light = resolveCesiumProgressColors(false)
    val dark = resolveCesiumProgressColors(true)

    assertEquals(CesiumDesignTokens.Light.AskAccent.toInt(), light.completed)
    assertEquals(CesiumDesignTokens.Light.WorkflowAccent.toInt(), light.active)
    assertEquals(CesiumDesignTokens.Light.TextSecondary.toInt(), light.pending)
    assertEquals(CesiumDesignTokens.Light.BurnAccent.toInt(), light.burn)

    assertEquals(CesiumDesignTokens.Dark.AskAccent.toInt(), dark.completed)
    assertEquals(CesiumDesignTokens.Dark.WorkflowAccent.toInt(), dark.active)
    assertEquals(CesiumDesignTokens.Dark.TextSecondary.toInt(), dark.pending)
    assertEquals(CesiumDesignTokens.Dark.BurnAccent.toInt(), dark.burn)

    assertNotEquals(light.completed, dark.completed)
    assertNotEquals(light.active, dark.active)
  }
}

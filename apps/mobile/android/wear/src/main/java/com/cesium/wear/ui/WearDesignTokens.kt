package com.cesium.wear.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cesium.shared.generated.CesiumDesignTokens

internal object CesiumWearColors {
  val Background = Color(CesiumDesignTokens.Dark.Background)
  val BackgroundDeep = Color(CesiumDesignTokens.Dark.BackgroundMain)
  val Panel = Color(CesiumDesignTokens.Dark.Panel)
  val Card = Color(CesiumDesignTokens.Dark.Card)
  val CardHover = Color(CesiumDesignTokens.Dark.CardHover)
  val Border = Color(CesiumDesignTokens.Dark.Border)
  val BorderSubtle = Color(CesiumDesignTokens.Dark.BorderSubtle)
  val TextPrimary = Color(CesiumDesignTokens.Dark.TextPrimary)
  val TextSecondary = Color(CesiumDesignTokens.Dark.TextSecondary)
  val TextDisabled = Color(CesiumDesignTokens.Dark.TextDisabled)
  val Accent = Color(CesiumDesignTokens.Dark.Accent)
  val AccentSoft = Color(CesiumDesignTokens.Dark.AccentSoft)
  val PlanGold = Color(CesiumDesignTokens.Dark.PlanAccent)
  val PlanGoldDark = Color(CesiumDesignTokens.Dark.PlanAccentDark)
  val PlanGoldPanel = Color(CesiumDesignTokens.Dark.PlanAccentPanel)
  val PlanGoldBorder = Color(CesiumDesignTokens.Dark.PlanAccent).copy(alpha = 0.42f)
  val Danger = Color(CesiumDesignTokens.Dark.Danger)
}

internal object CesiumWearSpacing {
  val ScreenHorizontal = 22.dp
  val ScreenVertical = 16.dp
  val CardPadding = 10.dp
  val ChipHorizontal = 14.dp
  val ChipVertical = 10.dp
  val GapSmall = 6.dp
  val Gap = 8.dp
  val GapLarge = 10.dp
  val BottomControl = 52.dp
}

internal object CesiumWearRadius {
  val Card = CesiumDesignTokens.Dark.RadiusCard.dp
  val Pill = CesiumDesignTokens.Dark.RadiusPill.dp
  val Composer = CesiumDesignTokens.Dark.RadiusCard.dp
}

internal object CesiumWearType {
  val Label = CesiumDesignTokens.Dark.FontSmall.sp
  val Meta = CesiumDesignTokens.Dark.FontMeta.sp
  val Body = CesiumDesignTokens.Dark.FontBody.sp
  val BodyLarge = 16.sp
  val Hero = 20.sp
}

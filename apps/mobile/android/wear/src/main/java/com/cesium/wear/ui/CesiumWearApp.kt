package com.cesium.wear.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.cesium.wear.data.WatchStateStore
import com.cesium.wear.model.WATCH_SCHEMA_VERSION
import com.cesium.wear.model.WatchAgentActionRequest
import com.cesium.wear.model.WatchAgentProjection
import com.cesium.wear.sync.PhoneCompanionActionClient
import com.cesium.wear.sync.WatchConnectionMode
import com.cesium.wear.sync.WearDataLayerRepository
import com.cesium.wear.sync.label
import com.cesium.wear.sync.resolveConnectionMode
import com.cesium.shared.wear.PhoneRelayStatus
import kotlinx.coroutines.launch

private enum class WearScreen {
  GLANCE,
  LIST,
  INTERVENTION,
  CONTROLS,
  CONNECTION,
  SETTINGS
}

private fun PhoneRelayStatus.label(): String =
  when (this) {
    PhoneRelayStatus.NEARBY -> "Phone nearby"
    PhoneRelayStatus.CLOUD -> "Phone via cloud"
    PhoneRelayStatus.NOT_PAIRED -> "Phone not paired"
    PhoneRelayStatus.OFFLINE -> "Phone offline"
  }

@Composable
fun CesiumWearApp(
  stateStore: WatchStateStore,
  dataLayerRepository: WearDataLayerRepository,
  actionClient: PhoneCompanionActionClient
) {
  val scope = rememberCoroutineScope()
  val envelope by stateStore.envelopeFlow.collectAsState(initial = null)
  val modePreference by stateStore.modePreferenceFlow.collectAsState(initial = "auto")
  var phoneRelayStatus by remember { mutableStateOf(PhoneRelayStatus.OFFLINE) }
  var screen by remember { mutableStateOf(WearScreen.GLANCE) }
  val projection = envelope?.projection
  val mode = resolveConnectionMode(
    envelope = envelope,
    preference = modePreference,
    phoneRelayReachable =
      phoneRelayStatus == PhoneRelayStatus.NEARBY ||
        phoneRelayStatus == PhoneRelayStatus.CLOUD,
    directConfigured = envelope?.server?.baseUrl?.isNotBlank() == true
  )

  LaunchedEffect(Unit) {
    dataLayerRepository.loadInitialCompanionState()
    phoneRelayStatus = dataLayerRepository.phoneRelayStatus()
  }

  WearShell {
    when (screen) {
      WearScreen.GLANCE -> GlanceScreen(
        projection = projection,
        connectionLabel =
          if (mode == WatchConnectionMode.PHONE_COMPANION) phoneRelayStatus.label()
          else mode.label(projection?.source),
        onPrimary = {
          if (projection?.pendingIntervention != null) {
            screen = WearScreen.INTERVENTION
          } else {
            screen = WearScreen.CONTROLS
          }
        },
        onList = { screen = WearScreen.LIST },
        onConnection = { screen = WearScreen.CONNECTION }
      )
      WearScreen.LIST -> ConversationListScreen(
        projection = projection,
        onBack = { screen = WearScreen.GLANCE },
        onOpen = { screen = WearScreen.GLANCE }
      )
      WearScreen.INTERVENTION -> InterventionScreen(
        projection = projection,
        onBack = { screen = WearScreen.GLANCE },
        onOpenPhone = { projection?.let { scope.launch { actionClient.send(openOnPhone(it)) } } }
      )
      WearScreen.CONTROLS -> ControlsScreen(
        projection = projection,
        onBack = { screen = WearScreen.GLANCE },
        onAction = { action ->
          projection?.let {
            scope.launch { actionClient.send(simpleAction(action, it)) }
          }
        }
      )
      WearScreen.CONNECTION -> ConnectionScreen(
        mode = mode,
        modePreference = modePreference,
        serverLabel = "${envelope?.server?.label ?: "No server"} · ${phoneRelayStatus.label()}",
        onBack = { screen = WearScreen.GLANCE },
        onSettings = { screen = WearScreen.SETTINGS }
      )
      WearScreen.SETTINGS -> SettingsScreen(
        modePreference = modePreference,
        onBack = { screen = WearScreen.CONNECTION },
        onMode = { next -> scope.launch { stateStore.saveModePreference(next) } }
      )
    }
  }
}

@Composable
private fun WearShell(content: @Composable () -> Unit) {
  Box(
    modifier = Modifier
      .fillMaxSize()
      .background(CesiumWearColors.Background)
  ) {
    Box(
      modifier = Modifier
        .fillMaxSize()
        .background(
          Brush.radialGradient(
            listOf(CesiumWearColors.Panel, CesiumWearColors.BackgroundDeep),
            radius = 280f
          )
        )
    )
    content()
    Box(
      modifier = Modifier
        .fillMaxWidth()
        .height(42.dp)
        .align(Alignment.TopCenter)
        .background(Brush.verticalGradient(listOf(CesiumWearColors.BackgroundDeep, Color.Transparent)))
    )
    Box(
      modifier = Modifier
        .fillMaxWidth()
        .height(42.dp)
        .align(Alignment.BottomCenter)
        .background(Brush.verticalGradient(listOf(Color.Transparent, CesiumWearColors.BackgroundDeep)))
    )
  }
}

@Composable
private fun GlanceScreen(
  projection: WatchAgentProjection?,
  connectionLabel: String,
  onPrimary: () -> Unit,
  onList: () -> Unit,
  onConnection: () -> Unit
) {
  val hasPendingInput = projection?.pendingIntervention != null
  Column(
    modifier = Modifier
      .fillMaxSize()
      .padding(horizontal = CesiumWearSpacing.ScreenHorizontal, vertical = CesiumWearSpacing.ScreenVertical),
    verticalArrangement = Arrangement.Center,
    horizontalAlignment = Alignment.CenterHorizontally
  ) {
    StatusBadge(connectionLabel, highlighted = hasPendingInput)
    Spacer(Modifier.height(CesiumWearSpacing.Gap))
    CesiumCard(highlighted = hasPendingInput) {
      Label(if (hasPendingInput) "Needs Input" else "Current Agent")
      Spacer(Modifier.height(CesiumWearSpacing.GapSmall))
      HeroText(projection?.title ?: "No active agent", maxLines = 2)
      Spacer(Modifier.height(CesiumWearSpacing.Gap))
      ActivityPanel(projection?.currentActivity ?: "Waiting for phone or server sync")
      Spacer(Modifier.height(CesiumWearSpacing.Gap))
      MetaLine(projection?.let { "${it.chip} · ${formatDuration(it.elapsedMs)}" } ?: "Offline")
    }
    Spacer(Modifier.height(CesiumWearSpacing.GapLarge))
    BottomActions(
      primary = if (hasPendingInput) "Ask" else "Ctl",
      caption = if (hasPendingInput) "Respond" else "Controls",
      attention = hasPendingInput,
      onPrimary = onPrimary,
      secondary = listOf("List" to onList, "Link" to onConnection)
    )
  }
}

@Composable
private fun ConversationListScreen(
  projection: WatchAgentProjection?,
  onBack: () -> Unit,
  onOpen: () -> Unit
) {
  ScrollScreen(title = "Agents", onBack = onBack) {
    ProjectionRow(projection, onOpen)
    ProjectionRow(null, onOpen, label = "Recent agents will appear here")
  }
}

@Composable
private fun InterventionScreen(
  projection: WatchAgentProjection?,
  onBack: () -> Unit,
  onOpenPhone: () -> Unit
) {
  ScrollScreen(title = "Needs Input", onBack = onBack) {
    CesiumCard(highlighted = projection?.pendingIntervention != null) {
      Label("Intervention")
      Spacer(Modifier.height(CesiumWearSpacing.GapSmall))
      HeroText(projection?.currentActivity ?: "No intervention pending", maxLines = 3)
      Spacer(Modifier.height(CesiumWearSpacing.Gap))
      MetaLine(projection?.pendingIntervention?.name?.lowercase() ?: "No active request")
    }
    Spacer(Modifier.height(CesiumWearSpacing.Gap))
    ActionChip("Open on phone", onOpenPhone)
    ActionChip("Dictate answer", onOpenPhone)
    ActionChip("Not now", onBack)
  }
}

@Composable
private fun ControlsScreen(
  projection: WatchAgentProjection?,
  onBack: () -> Unit,
  onAction: (String) -> Unit
) {
  ScrollScreen(title = "Controls", onBack = onBack) {
    ActionChip("Pause", { onAction("pause") }, enabled = projection?.availableActions?.contains("pause") == true)
    ActionChip("Resume", { onAction("resume") }, enabled = projection?.availableActions?.contains("resume") == true)
    ActionChip("Cancel", { onAction("cancel") }, enabled = projection?.availableActions?.contains("cancel") == true)
    ActionChip("Open phone", { onAction("open_on_phone") }, enabled = projection != null)
  }
}

@Composable
private fun ConnectionScreen(
  mode: WatchConnectionMode,
  modePreference: String,
  serverLabel: String,
  onBack: () -> Unit,
  onSettings: () -> Unit
) {
  ScrollScreen(title = "Connection", onBack = onBack) {
    CesiumCard {
      Label("Mode")
      Spacer(Modifier.height(CesiumWearSpacing.GapSmall))
      HeroText(mode.label(), maxLines = 1)
      Spacer(Modifier.height(CesiumWearSpacing.Gap))
      MetaLine(serverLabel)
      MetaLine("Preference: $modePreference")
    }
    Spacer(Modifier.height(CesiumWearSpacing.Gap))
    ActionChip("Settings", onSettings)
  }
}

@Composable
private fun SettingsScreen(
  modePreference: String,
  onBack: () -> Unit,
  onMode: (String) -> Unit
) {
  ScrollScreen(title = "Settings", onBack = onBack) {
    Label("Sync Preference")
    Spacer(Modifier.height(CesiumWearSpacing.GapSmall))
    listOf("auto", "direct", "phone", "cache-only").forEach { mode ->
      ActionChip(
        label = if (mode == modePreference) "$mode *" else mode,
        onClick = { onMode(mode) }
      )
    }
  }
}

@Composable
private fun ScrollScreen(
  title: String,
  onBack: () -> Unit,
  content: @Composable () -> Unit
) {
  Column(
    modifier = Modifier
      .fillMaxSize()
      .verticalScroll(rememberScrollState())
      .padding(horizontal = CesiumWearSpacing.ScreenHorizontal, vertical = 26.dp)
  ) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      SmallRoundButton("<", onBack)
      Spacer(Modifier.width(CesiumWearSpacing.Gap))
      Label(title)
    }
    Spacer(Modifier.height(CesiumWearSpacing.GapLarge))
    content()
  }
}

@Composable
private fun ProjectionRow(
  projection: WatchAgentProjection?,
  onClick: () -> Unit,
  label: String = projection?.title ?: "No active conversation"
) {
  CesiumCard(
    modifier = Modifier
      .fillMaxWidth()
      .padding(vertical = 4.dp),
    onClick = onClick
  ) {
    Column {
      Row(verticalAlignment = Alignment.CenterVertically) {
        StatusDot(if (projection == null) CesiumWearColors.TextDisabled else CesiumWearColors.PlanGold)
        Spacer(Modifier.width(CesiumWearSpacing.GapSmall))
        Label(projection?.chip ?: "OFF")
      }
      Spacer(Modifier.height(CesiumWearSpacing.GapSmall))
      BodyText(label, weight = FontWeight.Medium)
      MetaLine(projection?.currentActivity ?: "Waiting for sync")
    }
  }
}

@Composable
private fun PromptPill(text: String) {
  ActivityPanel(text)
}

@Composable
private fun BottomActions(
  primary: String,
  caption: String,
  attention: Boolean,
  onPrimary: () -> Unit,
  secondary: List<Pair<String, () -> Unit>>
) {
  Row(
    modifier = Modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.Center,
    verticalAlignment = Alignment.CenterVertically
  ) {
    secondary.take(1).forEach { (label, action) -> SmallRoundButton(label, action) }
    Spacer(Modifier.width(CesiumWearSpacing.Gap))
    Box(
      modifier = Modifier
        .size(CesiumWearSpacing.BottomControl)
        .clip(CircleShape)
        .background(if (attention) CesiumWearColors.PlanGold else CesiumWearColors.Accent)
        .border(1.dp, if (attention) CesiumWearColors.PlanGoldDark else CesiumWearColors.AccentSoft, CircleShape)
        .clickable(onClick = onPrimary),
      contentAlignment = Alignment.Center
    ) {
      Column(horizontalAlignment = Alignment.CenterHorizontally) {
        BasicText(
          primary.uppercase().take(3),
          style = TextStyle(
            color = CesiumWearColors.BackgroundDeep,
            fontSize = CesiumWearType.Body,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center
          )
        )
        BasicText(
          caption.uppercase().take(4),
          style = TextStyle(
            color = CesiumWearColors.BackgroundDeep,
            fontSize = CesiumWearType.Label,
            fontWeight = FontWeight.Medium,
            textAlign = TextAlign.Center
          )
        )
      }
    }
    Spacer(Modifier.width(CesiumWearSpacing.Gap))
    secondary.drop(1).take(1).forEach { (label, action) -> SmallRoundButton(label, action) }
  }
}

@Composable
private fun ActionChip(label: String, onClick: () -> Unit, enabled: Boolean = true) {
  Box(
    modifier = Modifier
      .fillMaxWidth()
      .padding(vertical = 4.dp)
      .clip(RoundedCornerShape(CesiumWearRadius.Card))
      .background(if (enabled) CesiumWearColors.Panel else CesiumWearColors.BackgroundDeep)
      .border(
        1.dp,
        if (enabled) CesiumWearColors.BorderSubtle else CesiumWearColors.BorderSubtle,
        RoundedCornerShape(CesiumWearRadius.Card)
      )
      .clickable(enabled = enabled, onClick = onClick)
      .padding(horizontal = CesiumWearSpacing.ChipHorizontal, vertical = CesiumWearSpacing.ChipVertical)
  ) {
    BasicText(
      label,
      style = TextStyle(
        color = if (enabled) CesiumWearColors.TextPrimary else CesiumWearColors.TextDisabled,
        fontSize = CesiumWearType.Body,
        fontWeight = FontWeight.Medium
      )
    )
  }
}

@Composable
private fun SmallRoundButton(label: String, onClick: () -> Unit) {
  Box(
    modifier = Modifier
      .size(42.dp)
      .clip(CircleShape)
      .background(CesiumWearColors.Panel)
      .border(1.dp, CesiumWearColors.BorderSubtle, CircleShape)
      .clickable(onClick = onClick),
    contentAlignment = Alignment.Center
  ) {
    BasicText(
      label,
      style = TextStyle(color = CesiumWearColors.TextPrimary, fontSize = CesiumWearType.Label, fontWeight = FontWeight.Bold)
    )
  }
}

@Composable
private fun HeroText(text: String, maxLines: Int) {
  BasicText(
    text,
    maxLines = maxLines,
    overflow = TextOverflow.Ellipsis,
    style = TextStyle(
      color = CesiumWearColors.TextPrimary,
      fontSize = CesiumWearType.Hero,
      fontWeight = FontWeight.SemiBold,
      textAlign = TextAlign.Center
    )
  )
}

@Composable
private fun Label(text: String) {
  BasicText(
    text.uppercase(),
    style = TextStyle(
      color = CesiumWearColors.PlanGold,
      fontSize = CesiumWearType.Label,
      fontWeight = FontWeight.Bold
    )
  )
}

@Composable
private fun MetaLine(text: String) {
  BasicText(
    text,
    maxLines = 2,
    overflow = TextOverflow.Ellipsis,
    style = TextStyle(color = CesiumWearColors.TextSecondary, fontSize = CesiumWearType.Meta)
  )
}

@Composable
private fun BodyText(text: String, weight: FontWeight = FontWeight.Normal) {
  BasicText(
    text,
    maxLines = 2,
    overflow = TextOverflow.Ellipsis,
    style = TextStyle(color = CesiumWearColors.TextPrimary, fontSize = CesiumWearType.BodyLarge, fontWeight = weight)
  )
}

@Composable
private fun CesiumCard(
  modifier: Modifier = Modifier,
  highlighted: Boolean = false,
  onClick: (() -> Unit)? = null,
  content: @Composable () -> Unit
) {
  val shape = RoundedCornerShape(CesiumWearRadius.Card)
  val clickableModifier = if (onClick == null) Modifier else Modifier.clickable(onClick = onClick)
  Box(
    modifier = modifier
      .clip(shape)
      .background(if (highlighted) CesiumWearColors.PlanGoldPanel else CesiumWearColors.Panel)
      .border(1.dp, if (highlighted) CesiumWearColors.PlanGoldBorder else CesiumWearColors.BorderSubtle, shape)
      .then(clickableModifier)
      .padding(CesiumWearSpacing.CardPadding)
  ) {
    Column(
      modifier = Modifier.fillMaxWidth(),
      horizontalAlignment = Alignment.CenterHorizontally
    ) {
      content()
    }
  }
}

@Composable
private fun StatusBadge(text: String, highlighted: Boolean) {
  Row(
    modifier = Modifier
      .clip(RoundedCornerShape(CesiumWearRadius.Pill))
      .background(if (highlighted) CesiumWearColors.PlanGoldPanel else CesiumWearColors.AccentSoft)
      .border(
        1.dp,
        if (highlighted) CesiumWearColors.PlanGoldBorder else CesiumWearColors.BorderSubtle,
        RoundedCornerShape(CesiumWearRadius.Pill)
      )
      .padding(horizontal = 10.dp, vertical = 6.dp),
    verticalAlignment = Alignment.CenterVertically
  ) {
    StatusDot(if (highlighted) CesiumWearColors.PlanGold else CesiumWearColors.TextSecondary)
    Spacer(Modifier.width(CesiumWearSpacing.GapSmall))
    Label(text)
  }
}

@Composable
private fun StatusDot(color: Color) {
  Box(
    modifier = Modifier
      .size(6.dp)
      .clip(CircleShape)
      .background(color)
  )
}

@Composable
private fun ActivityPanel(text: String) {
  Box(
    modifier = Modifier
      .fillMaxWidth()
      .clip(RoundedCornerShape(CesiumWearRadius.Composer))
      .background(CesiumWearColors.Card)
      .border(1.dp, CesiumWearColors.Border, RoundedCornerShape(CesiumWearRadius.Composer))
      .padding(horizontal = 12.dp, vertical = 10.dp)
  ) {
    BasicText(
      text,
      maxLines = 2,
      overflow = TextOverflow.Ellipsis,
      style = TextStyle(
        color = CesiumWearColors.TextPrimary,
        fontSize = CesiumWearType.BodyLarge,
        fontWeight = FontWeight.Medium,
        textAlign = TextAlign.Center
      )
    )
  }
}

private fun simpleAction(action: String, projection: WatchAgentProjection): WatchAgentActionRequest =
  WatchAgentActionRequest(
    schemaVersion = WATCH_SCHEMA_VERSION,
    action = action,
    workspaceId = projection.workspaceId,
    conversationId = projection.conversationId
  )

private fun openOnPhone(projection: WatchAgentProjection): WatchAgentActionRequest =
  simpleAction("open_on_phone", projection)

private fun formatDuration(ms: Long): String {
  val totalSeconds = (ms / 1000).coerceAtLeast(0)
  val minutes = totalSeconds / 60
  val seconds = totalSeconds % 60
  return if (minutes > 0) "${minutes}m ${seconds}s" else "${seconds}s"
}

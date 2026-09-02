package com.cesium.wear.direct

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AgentProjectionBuilderTest {
  private val longCommand =
    "find / -name \"bun\" -type f -not -path \"*/node_modules/*\" 2>/dev/null | head -5; " +
      "echo \"---\"; ls -la ~/.bun/bin"

  @Test
  fun neverSurfacesRawToolCallJsonArguments() {
    val projection = projectionFor(
      events = listOf(
        toolCallEvent(
          seq = 1,
          title = "Run $longCommand",
          toolKind = "terminal",
          status = "in_progress",
          detail = "{\"command\":\"$longCommand\"}"
        )
      )
    )
    assertEquals("Running a terminal command", projection?.currentActivity)
  }

  @Test
  fun keepsShortCleanToolTitlesVerbatim() {
    val projection = projectionFor(
      events = listOf(
        toolCallEvent(
          seq = 1,
          title = "Read package.json",
          toolKind = "read",
          status = "in_progress",
          detail = "{\"path\":\"package.json\"}"
        )
      )
    )
    assertEquals("Read package.json", projection?.currentActivity)
  }

  @Test
  fun toolCallUpdateInheritsDescriptiveFieldsFromOrigin() {
    val projection = projectionFor(
      events = listOf(
        toolCallEvent(
          seq = 1,
          title = "Run $longCommand",
          toolKind = "terminal",
          status = "pending"
        ),
        buildJsonObject {
          put("seq", 2L)
          put("kind", "tool_call_update")
          put("toolCallId", "call-1")
          put("status", "in_progress")
          put("detail", "chunk of raw stdout\nwith newlines")
        }
      )
    )
    assertEquals("Running a terminal command", projection?.currentActivity)
  }

  @Test
  fun skipsVerboseAutoAcceptStatusDetails() {
    val projection = projectionFor(
      events = listOf(
        buildJsonObject {
          put("seq", 1L)
          put("kind", "status")
          put("status", "running")
          put("detail", "Auto-accepted Run $longCommand (auto-accept all permissions).")
        }
      )
    )
    assertEquals("Agent is working", projection?.currentActivity)
  }

  @Test
  fun keepsShortCleanStatusDetails() {
    val projection = projectionFor(
      events = listOf(
        buildJsonObject {
          put("seq", 1L)
          put("kind", "status")
          put("status", "running")
          put("detail", "Auto-accepted Run npm test.")
        }
      )
    )
    assertEquals("Auto-accepted Run npm test.", projection?.currentActivity)
  }

  @Test
  fun oversizedPermissionTitleFallsBackToCategoryLabel() {
    val projection = projectionFor(
      status = "awaiting_permission",
      pendingPermission = buildJsonObject {
        put("requestId", "perm")
        put("permission", "terminal")
        put("title", "Run $longCommand")
        put("detail", "{\"command\":\"$longCommand\"}")
      },
      events = emptyList()
    )
    assertEquals("Wants to run a terminal command", projection?.currentActivity)
  }

  @Test
  fun sanitizeCollapsesWhitespaceAndBoundsLength() {
    assertEquals(
      "Provider responded with 500. Request took too long",
      sanitizeActivityText("Provider responded with 500.\n  Request took too long")
    )
    val truncated = sanitizeActivityText("x".repeat(400))
    assertEquals(120, truncated?.length)
    assertEquals('…', truncated?.last())
    assertNull(sanitizeActivityText("{\"error\":{\"message\":\"Compilation failed\"}}"))
  }

  @Test
  fun toolKindLabelUsesFileBasename() {
    val locations = buildJsonArray {
      addJsonObject { put("path", "apps/mobile/src/services/LiveUpdateController.ts") }
    }
    assertEquals("Editing LiveUpdateController.ts", toolKindActivityLabel("edit", locations))
    assertEquals("Running a terminal command", toolKindActivityLabel("terminal", null))
    assertNull(toolKindActivityLabel("mystery-kind", null))
  }

  private fun projectionFor(
    status: String = "running",
    pendingPermission: JsonObject? = null,
    events: List<JsonObject>
  ): com.cesium.wear.model.WatchAgentProjection? {
    val builder = AgentProjectionBuilder()
    val snapshot = buildJsonObject {
      put("type", "snapshot")
      putJsonObject("snapshot") {
        putJsonObject("conversation") {
          put("id", "c1")
          put("workspaceId", "w1")
          put("title", "Mobile run")
          put("status", status)
          put("updatedAt", 1_000L)
          put("lastEventSeq", events.size.toLong())
          if (pendingPermission != null) {
            put("pendingPermission", pendingPermission)
          }
        }
        putJsonArray("events") {
          events.forEach { add(it) }
        }
      }
    }
    return builder.applySocketMessage(snapshot)
  }

  private fun toolCallEvent(
    seq: Long,
    title: String,
    toolKind: String,
    status: String,
    detail: String? = null
  ): JsonObject = buildJsonObject {
    put("seq", seq)
    put("kind", "tool_call")
    put("toolCallId", "call-1")
    put("title", title)
    put("toolKind", toolKind)
    put("status", status)
    if (detail != null) {
      put("detail", detail)
    }
  }
}

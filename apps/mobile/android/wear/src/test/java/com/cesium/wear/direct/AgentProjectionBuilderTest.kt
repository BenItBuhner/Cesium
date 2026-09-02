package com.cesium.wear.direct

import com.cesium.wear.model.WatchPendingIntervention
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

class AgentProjectionBuilderTest {
  private fun parse(json: String): JsonObject =
    Json.parseToJsonElement(json) as JsonObject

  private val awaitingQuestionConversation =
    """
    {
      "type": "conversation",
      "conversation": {
        "id": "c1",
        "workspaceId": "w1",
        "title": "Mobile run",
        "status": "awaiting_question",
        "updatedAt": 2000,
        "lastEventSeq": 1,
        "pendingQuestion": { "questionId": "q1", "requestedAt": 2000 }
      }
    }
    """

  @Test
  fun surfacesThePendingQuestionPromptVerbatim() {
    val builder = AgentProjectionBuilder()
    builder.applySocketMessage(parse(awaitingQuestionConversation))
    val projection = builder.applySocketMessage(
      parse(
        """
        {
          "type": "event",
          "event": {
            "seq": 1,
            "kind": "question",
            "questionId": "q1",
            "prompt": "Which area of the Model-Proxy monorepo should this land in?",
            "status": "pending"
          }
        }
        """
      )
    )

    assertEquals(WatchPendingIntervention.QUESTION, projection?.pendingIntervention)
    assertEquals(
      "Which area of the Model-Proxy monorepo should this land in?",
      projection?.currentActivity
    )
  }

  @Test
  fun fallsBackWhenTheQuestionEventIsOutsideTheWindow() {
    val builder = AgentProjectionBuilder()
    val projection = builder.applySocketMessage(parse(awaitingQuestionConversation))

    assertEquals("Needs an answer", projection?.currentActivity)
  }
}

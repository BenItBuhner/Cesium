package com.cesium.wear.surface

import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.LongTextComplicationData
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.RangedValueComplicationData
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import androidx.wear.watchface.complications.datasource.ComplicationDataSourceService
import androidx.wear.watchface.complications.datasource.ComplicationDataSourceService.ComplicationRequestListener
import androidx.wear.watchface.complications.datasource.ComplicationRequest
import com.cesium.wear.data.WatchStateStore
import kotlinx.coroutines.runBlocking

class AgentStatusComplicationService : ComplicationDataSourceService() {
  override fun onComplicationRequest(
    request: ComplicationRequest,
    listener: ComplicationRequestListener
  ) {
    val projection = runBlocking { WatchStateStore(this@AgentStatusComplicationService).latestEnvelope() }?.projection
    listener.onComplicationData(
      when (request.complicationType) {
        ComplicationType.LONG_TEXT -> LongTextComplicationData.Builder(
          text = PlainComplicationText.Builder(projection?.currentActivity ?: "No active agent").build(),
          contentDescription = PlainComplicationText.Builder("Cesium agent status").build()
        )
          .setTitle(PlainComplicationText.Builder(projection?.chip ?: "OFF").build())
          .build()
        ComplicationType.RANGED_VALUE -> RangedValueComplicationData.Builder(
          value = progressValue(projection?.elapsedMs ?: 0),
          min = 0f,
          max = 100f,
          contentDescription = PlainComplicationText.Builder("Cesium agent progress").build()
        )
          .setText(PlainComplicationText.Builder(projection?.chip ?: "OFF").build())
          .build()
        else -> ShortTextComplicationData.Builder(
          text = PlainComplicationText.Builder(projection?.chip ?: "OFF").build(),
          contentDescription = PlainComplicationText.Builder("Cesium agent status").build()
        )
          .setTitle(PlainComplicationText.Builder(projection?.title ?: "Cesium").build())
          .build()
      }
    )
  }

  override fun getPreviewData(type: ComplicationType): ComplicationData? =
    ShortTextComplicationData.Builder(
      text = PlainComplicationText.Builder("RUN").build(),
      contentDescription = PlainComplicationText.Builder("Cesium agent status").build()
    ).setTitle(PlainComplicationText.Builder("Cesium").build()).build()

  private fun progressValue(elapsedMs: Long): Float =
    ((elapsedMs / 1000) % 100).toFloat()
}

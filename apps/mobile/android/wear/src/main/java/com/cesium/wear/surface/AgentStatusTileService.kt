package com.cesium.wear.surface

import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.TileService
import com.cesium.wear.data.WatchStateStore
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.runBlocking

class AgentStatusTileService : TileService() {
  override fun onTileRequest(requestParams: RequestBuilders.TileRequest): ListenableFuture<TileBuilders.Tile> {
    val envelope = runBlocking { WatchStateStore(this@AgentStatusTileService).latestEnvelope() }
    val projection = envelope?.projection
    val root = LayoutElementBuilders.Column.Builder()
      .addContent(
        LayoutElementBuilders.Text.Builder()
          .setText(projection?.chip ?: "OFF")
          .build()
      )
      .addContent(
        LayoutElementBuilders.Text.Builder()
          .setText(projection?.title ?: "Cesium")
          .setMaxLines(1)
          .build()
      )
      .addContent(
        LayoutElementBuilders.Text.Builder()
          .setText(projection?.currentActivity ?: "Waiting for Cesium sync")
          .setMaxLines(2)
          .build()
      )
      .build()
    val tile = TileBuilders.Tile.Builder()
      .setResourcesVersion("1")
      .setTileTimeline(
        TimelineBuilders.Timeline.Builder()
          .addTimelineEntry(
            TimelineBuilders.TimelineEntry.Builder()
              .setLayout(
                LayoutElementBuilders.Layout.Builder()
                  .setRoot(root)
                  .build()
              )
              .build()
          )
          .build()
      )
      .build()
    return Futures.immediateFuture(tile)
  }

  override fun onTileResourcesRequest(
    requestParams: RequestBuilders.ResourcesRequest
  ): ListenableFuture<ResourceBuilders.Resources> =
    Futures.immediateFuture(
      ResourceBuilders.Resources.Builder()
        .setVersion("1")
        .build()
    )
}

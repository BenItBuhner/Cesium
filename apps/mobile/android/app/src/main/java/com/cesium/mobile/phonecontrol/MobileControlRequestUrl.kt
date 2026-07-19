package com.cesium.mobile.phonecontrol

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

internal fun buildMobileControlRequestUrl(serverUrl: String, workspaceId: String): HttpUrl? {
  val base = serverUrl.toHttpUrlOrNull() ?: return null
  return base.newBuilder()
    .encodedPath("/ws/mobile-control")
    .query(null)
    .addQueryParameter("workspaceId", workspaceId)
    .build()
}

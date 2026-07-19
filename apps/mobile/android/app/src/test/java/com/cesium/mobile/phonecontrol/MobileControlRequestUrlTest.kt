package com.cesium.mobile.phonecontrol

import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

class MobileControlRequestUrlTest {
  @Test
  fun `builds an HTTP request URL for OkHttp WebSocket upgrade`() {
    val url = buildMobileControlRequestUrl(
      "http://172.30.0.2:9100",
      "8af22c44f404"
    )

    assertNotNull(url)
    assertEquals("http", url!!.scheme)
    assertEquals(
      "http://172.30.0.2:9100/ws/mobile-control?workspaceId=8af22c44f404",
      Request.Builder().url(url).build().url.toString()
    )
  }

  @Test
  fun `preserves HTTPS and replaces existing path and query`() {
    val url = buildMobileControlRequestUrl(
      "https://cesium.example/old/path?ignored=true",
      "workspace/with spaces"
    )

    assertNotNull(url)
    assertEquals("https", url!!.scheme)
    assertEquals("/ws/mobile-control", url.encodedPath)
    assertEquals("workspace/with spaces", url.queryParameter("workspaceId"))
  }
}

package com.cesium.wear.sync

import com.cesium.wear.model.WatchAgentSyncEnvelope
import com.cesium.wear.model.WatchConnectionSource

enum class WatchConnectionMode {
  DIRECT_SERVER,
  PHONE_COMPANION,
  CACHE,
  OFFLINE
}

fun resolveConnectionMode(
  envelope: WatchAgentSyncEnvelope?,
  preference: String,
  phoneRelayReachable: Boolean,
  directConfigured: Boolean,
  now: Long = System.currentTimeMillis()
): WatchConnectionMode {
  if (preference == "direct" && directConfigured) return WatchConnectionMode.DIRECT_SERVER
  if (preference == "phone" && phoneRelayReachable) return WatchConnectionMode.PHONE_COMPANION

  val projection = envelope?.projection
  val fresh = projection != null && (projection.staleAt <= 0 || projection.staleAt > now)
  if (preference == "cache-only" && projection != null) return WatchConnectionMode.CACHE
  if (directConfigured && (preference == "auto" || preference.isBlank())) return WatchConnectionMode.DIRECT_SERVER
  if (phoneRelayReachable && fresh) return WatchConnectionMode.PHONE_COMPANION
  if (projection != null) return WatchConnectionMode.CACHE
  return WatchConnectionMode.OFFLINE
}

fun WatchConnectionMode.label(source: WatchConnectionSource? = null): String =
  when (this) {
    WatchConnectionMode.DIRECT_SERVER -> "Live"
    WatchConnectionMode.PHONE_COMPANION -> "Via phone"
    WatchConnectionMode.CACHE -> if (source == WatchConnectionSource.PHONE_COMPANION) "Cached phone" else "Cached"
    WatchConnectionMode.OFFLINE -> "Offline"
  }

package com.cesium.wear.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.cesium.wear.model.WatchAgentSyncEnvelope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

private val Context.watchDataStore by preferencesDataStore(name = "cesium_wear_state")

class WatchStateStore(
  private val context: Context,
  private val json: Json = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
  }
) {
  private val envelopeKey = stringPreferencesKey("watch_sync_envelope")
  private val modePreferenceKey = stringPreferencesKey("connection_mode_preference")

  val envelopeFlow: Flow<WatchAgentSyncEnvelope?> =
    context.watchDataStore.data.map { preferences ->
      preferences[envelopeKey]?.let { raw ->
        runCatching { json.decodeFromString<WatchAgentSyncEnvelope>(raw) }.getOrNull()
      }
    }

  val modePreferenceFlow: Flow<String> =
    context.watchDataStore.data.map { preferences ->
      preferences[modePreferenceKey] ?: "auto"
    }

  suspend fun latestEnvelope(): WatchAgentSyncEnvelope? = envelopeFlow.first()

  suspend fun saveEnvelope(envelope: WatchAgentSyncEnvelope) {
    context.watchDataStore.edit { preferences ->
      preferences[envelopeKey] = json.encodeToString(envelope)
    }
  }

  suspend fun saveModePreference(mode: String) {
    context.watchDataStore.edit { preferences ->
      preferences[modePreferenceKey] = mode
    }
  }

  suspend fun clear() {
    context.watchDataStore.edit { preferences ->
      preferences.remove(envelopeKey)
    }
  }
}

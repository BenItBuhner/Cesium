package com.cesium.wear.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class WatchSecureTokenStore(private val context: Context) {
  private val prefs = context.getSharedPreferences("cesium_wear_secure_tokens", Context.MODE_PRIVATE)

  fun saveToken(serverKey: String, token: String?) {
    if (token.isNullOrBlank()) {
      clearToken(serverKey)
      return
    }
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
    val encrypted = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
    prefs.edit()
      .putString("${serverKey}:iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
      .putString("${serverKey}:token", Base64.encodeToString(encrypted, Base64.NO_WRAP))
      .apply()
  }

  fun readToken(serverKey: String): String? {
    val iv = prefs.getString("${serverKey}:iv", null)?.let { Base64.decode(it, Base64.NO_WRAP) } ?: return null
    val encrypted = prefs.getString("${serverKey}:token", null)?.let { Base64.decode(it, Base64.NO_WRAP) } ?: return null
    return runCatching {
      val cipher = Cipher.getInstance(TRANSFORMATION)
      cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
      String(cipher.doFinal(encrypted), Charsets.UTF_8)
    }.getOrNull()
  }

  fun clearToken(serverKey: String) {
    prefs.edit()
      .remove("${serverKey}:iv")
      .remove("${serverKey}:token")
      .apply()
  }

  private fun getOrCreateKey(): SecretKey {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.secretKey?.let {
      return it
    }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
      init(
        KeyGenParameterSpec.Builder(
          KEY_ALIAS,
          KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .setRandomizedEncryptionRequired(true)
          .build()
      )
      generateKey()
    }
  }

  companion object {
    private const val KEY_ALIAS = "cesium_wear_direct_server_token"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
  }
}

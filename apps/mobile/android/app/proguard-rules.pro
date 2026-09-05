# R8 rules for the release build (minifyEnabled + shrinkResources in app/build.gradle).
#
# React Native, Hermes, OkHttp, WorkManager and play-services ship their own
# consumer rules. Anything reached from the manifest (activities, services,
# receivers, the accessibility / voice-interaction services) is kept by AGP.
# Our React Native modules are kept by react-android's
# `-keep class * implements com.facebook.react.bridge.NativeModule { *; }`.

# Keep source file names and line numbers for readable release stack traces.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# kotlinx.serialization (used by :shared for the watch/agent contract). The
# generated serializers are looked up through the Companion object.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** {
    *** Companion;
}
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class com.cesium.**$$serializer { *; }
-keepclassmembers class com.cesium.** {
    *** Companion;
}
-keepclasseswithmembers class com.cesium.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# Wearable data-layer payloads are addressed by class name at runtime.
-keep class com.cesium.mobile.wear.** { *; }
-keep class com.cesium.shared.** { *; }

# OkHttp / Okio platform probes reference optional classes.
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

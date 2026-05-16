# Cesium Mobile

This workspace compiles the Cesium React Native application with Expo SDK 55. The first parity target is a native WebView shell around the existing Next/Electron renderer surface, so the mobile app inherits the current imports, components, styles, routing, and agent behavior from the web workbench without creating a divergent mobile fork.

## Local Android

Start the web app on the host machine:

```bash
npm run dev:web
```

Then run the native app:

```bash
npm run android:mobile
```

On the Android emulator the default web URL is `http://10.0.2.2:3000`. Override it when needed:

```powershell
$env:EXPO_PUBLIC_CESIUM_WEB_URL="http://10.0.2.2:3000"
npm run android:mobile
```

The Android emulator default API URL is `http://10.0.2.2:9100`, matching the server workspace default. Override it when your API server uses another host or port:

```powershell
$env:EXPO_PUBLIC_CESIUM_SERVER_URL="http://10.0.2.2:9100"
npm run android:mobile
```

The legacy `EXPO_PUBLIC_OPENCURSOR_WEB_URL` and
`EXPO_PUBLIC_OPENCURSOR_SERVER_URL` names still work for existing local setups.

## Verification

```bash
npm run typecheck --workspace @cesium/mobile
npm run build --workspace @cesium/mobile
```

The shell imports shared `@cesium/design` tokens and `@cesium/core/platform-surfaces` metadata, so future shared token or surface contract changes flow into the native app through the same packages used by web and desktop.

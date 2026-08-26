; Leftovers from electron-builder one-click + scoped package name.
; When oneClick=true and perMachine=false, APP_FILENAME becomes the sanitized
; npm name (@cesium/desktop → @cesiumdesktop) instead of "Cesium". Force the
; per-user install into %LOCALAPPDATA%\Programs\Cesium and clean the #214 path.

!macro preInit
  SetRegView 64
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\Cesium"
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\Cesium"
!macroend

!macro customInstall
  Delete "$DESKTOP\OpenCursor.lnk"
  Delete "$DESKTOP\Open Cursor.lnk"
  Delete "$SMPROGRAMS\OpenCursor.lnk"
  Delete "$SMPROGRAMS\Open Cursor.lnk"
  Delete "$DESKTOP\@cesiumdesktop.lnk"
  Delete "$SMPROGRAMS\@cesiumdesktop.lnk"
  RMDir /r "$LOCALAPPDATA\Programs\@cesiumdesktop"
!macroend

; Retro Messenger — NSIS customisations
;
; electron-builder always writes "Uninstall Retro Messenger.exe" into the install
; directory and registers it in Apps & Features, but it never creates a Start Menu
; entry for it. People who look for an uninstaller in the Start Menu conclude there
; isn't one. These macros add (and clean up) that shortcut.

!macro customInstall
  CreateShortCut "$SMPROGRAMS\Uninstall ${PRODUCT_NAME}.lnk" \
    "$INSTDIR\${UNINSTALL_FILENAME}" "/currentuser" \
    "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\Uninstall ${PRODUCT_NAME}.lnk"
!macroend

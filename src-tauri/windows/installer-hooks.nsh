; The bundled sidecar owns the browsers, so the app always stops it before an
; update installs. A crash, a forced close, or an interrupted shutdown can still
; leave one running, and the default template only closes the main executable.
; Installing over a running sidecar fails with "Error opening file for writing",
; so stop it here. Cloud sessions survive: every open browser's session is saved
; again from its encrypted local queue after the next start.
; An AI client keeps ghosteranti-mcp.exe open in the same way. Stopping it also
; stops its MCP helper, an ghosteranti-sidecar.exe process. Stop it first and
; without /T: the helper may have started GhosterAnti, which is not its to stop.
!macro NSIS_HOOK_PREINSTALL
  Push $R0

  nsExec::Exec 'taskkill /F /IM "ghosteranti-mcp.exe"'
  Pop $R0
  nsExec::Exec 'taskkill /IM "ghosteranti-sidecar.exe"'
  Pop $R0
  Sleep 5000
  nsExec::Exec 'taskkill /F /T /IM "ghosteranti-sidecar.exe"'
  Pop $R0
  Sleep 2000

  ; Python scripts now download their runtime into the app data folder. Remove the copy
  ; that earlier versions installed with the app; nothing installs or uninstalls it now.
  RMDir /r "$INSTDIR\playwright\python"

  Pop $R0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Earlier versions bundled CloakBrowser here. The app now downloads it into
  ; its data folder, so remove the old copy once the new files are in place. Files that
  ; a still-running browser holds stay until a later update.
  RMDir /r "$INSTDIR\cloakbrowser"

  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4

  ClearErrors
  ${GetOptions} $CMDLINE "/AMATTEMPT=" $R0
  ${IfNot} ${Errors}
    StrLen $R1 $R0
    ${If} $R1 != 32
      Abort
    ${EndIf}

    StrCpy $R2 0
    ghosteranti_attempt_character:
      StrCpy $R3 $R0 1 $R2
      ${StrLoc} $R4 "0123456789abcdef" $R3 ">"
      ${If} $R4 == ""
        Abort
      ${EndIf}
      IntOp $R2 $R2 + 1
      IntCmp $R2 32 ghosteranti_attempt_valid ghosteranti_attempt_character ghosteranti_attempt_invalid

    ghosteranti_attempt_invalid:
      Abort

    ghosteranti_attempt_valid:
      ClearErrors
      FileOpen $R1 "$INSTDIR\.ghosteranti-update-$R0.complete" w
      ${If} ${Errors}
        Abort
      ${EndIf}
      FileWrite $R1 "${VERSION}$\r$\n"
      FileClose $R1
      ${If} ${Errors}
        Abort
      ${EndIf}
  ${EndIf}

  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

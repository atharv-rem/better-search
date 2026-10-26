; Extra steps for the NSIS installer (bundle.windows.nsis.installerHooks).

; The app and its helper programs keep their files locked, so the installer and
; uninstaller stop them first. The installer's own check for the running app
; gives up ("Failed to kill Better Search") when the app is still on its way
; out, as it is right after the updater starts this installer and quits. So
; close it here and wait until it's gone; that check then finds nothing.
!macro StopBetterSearchPrograms
  StrCpy $R1 0
  ${Do}
    nsExec::Exec 'taskkill /F /IM better-search.exe'
    Pop $R0
    ; 128: none left. Give up after ~10s and let the installer's check decide.
    ${If} $R0 = 128
    ${OrIf} $R1 >= 40
      ${ExitDo}
    ${EndIf}
    Sleep 250
    IntOp $R1 $R1 + 1
  ${Loop}
  nsExec::Exec 'taskkill /F /IM better-search-helper.exe'
  nsExec::Exec 'taskkill /F /IM better-search-watcher.exe'
  nsExec::Exec 'taskkill /F /IM better-search-indexer.exe'
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro StopBetterSearchPrograms
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro StopBetterSearchPrograms
!macroend

; Removing the app takes its traces with it (Microsoft Store policy 10.2.7).
; Not when this is an update: the install is about to be put back.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    SetShellVarContext current

    ; "Launch at startup" in settings.
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "better-search"

    ; Search providers' API keys in Credential Manager, along with the app's
    ; data folders when the user ticked "Delete the application data".
    ${If} $DeleteAppDataCheckboxState = 1
      nsExec::Exec 'cmdkey /delete:better-search/exa'
      nsExec::Exec 'cmdkey /delete:better-search/firecrawl'
      nsExec::Exec 'cmdkey /delete:better-search/tinyfish'
      nsExec::Exec 'cmdkey /delete:better-search/context'
    ${EndIf}
  ${EndIf}
!macroend

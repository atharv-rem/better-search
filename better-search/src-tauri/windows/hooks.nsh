; Extra steps for the NSIS installer (bundle.windows.nsis.installerHooks).

; The helper programs run beside the app and keep their files locked, so the
; installer and uninstaller stop them first. The installer already closes the
; main program.
!macro StopBetterSearchPrograms
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

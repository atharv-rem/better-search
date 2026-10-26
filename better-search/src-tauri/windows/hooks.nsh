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

; The search index goes in the user's local app data folder (on C:), and the
; install can fit there when the index won't. The app offers to keep it on
; another drive when it starts, but say so up front. Not when the index was
; already moved (storage.rs records where), and not for silent updates.
!macro WarnIfLowSpace
  ReadRegStr $R2 HKCU "Software\better-search" "IndexFolder"
  ${If} $R2 == ""
    ${GetRoot} "$LOCALAPPDATA" $R0
    ${DriveSpace} "$R0\" "/D=F /S=M" $R1
    ; database.MinFreeSpace
    ${If} $R1 < 300
      MessageBox MB_YESNO|MB_ICONEXCLAMATION "Drive $R0 has only $R1 MB free.$\r$\n$\r$\nBetter Search needs about 300 MB for its search index. If another drive has more space, Better Search will offer to keep the index there when it starts. If not, free up some space on $R0 first.$\r$\n$\r$\nContinue installing?" /SD IDYES IDYES +2
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro WarnIfLowSpace
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

      ; A search index moved to another drive (storage.rs). Only its own
      ; files, and the folder if that leaves it empty.
      ReadRegStr $R0 HKCU "Software\better-search" "IndexFolder"
      ${If} $R0 != ""
        Delete "$R0\index.db"
        Delete "$R0\index.db-wal"
        Delete "$R0\index.db-shm"
        RMDir "$R0"
      ${EndIf}
      DeleteRegKey HKCU "Software\better-search"
    ${EndIf}
  ${EndIf}
!macroend

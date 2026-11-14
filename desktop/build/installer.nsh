; Monize's additions to electron-builder's NSIS installer and uninstaller.
;
; electron-builder includes this file ahead of its own template
; (node_modules/app-builder-lib/templates/nsis/) and inserts the macros below
; where the template names them. The template is compiled twice: once as the
; uninstaller (BUILD_UNINSTALLER defined) and once as the installer.
;
;   customHeader            top level of both, after the template's includes:
;                           the directory page's check (installer)
;   customInit              installer .onInit: refuses /allusers
;   customInstallMode       both, when the "who is this for" page is about to
;                           show: skips it, the install is per user
;   customCheckAppRunning   installer: first thing in the install section,
;                           before the old version is uninstalled and before a
;                           file is copied. Uninstaller: before a file is
;                           removed (un.onInit when silent, the uninstall
;                           section otherwise). An update runs both: the new
;                           installer's, then the old uninstaller's.
;                           Defining it REPLACES electron-builder's own "the
;                           application is running" check.
;   customUnInstall         uninstaller: in the uninstall section, just before
;                           the installation folder is deleted (on an update
;                           too: the installer runs the old uninstaller)
;   customUnInstallSection  uninstaller: the extra sections; defining it adds
;                           the components page that shows the checkbox
;
; desktop/README.md, "The installer", says what each one is for.

!include LogicLib.nsh
!include FileFunc.nsh

; ---------------------------------------------------------------------------
; Text. English only for now, and all of it here.
; ---------------------------------------------------------------------------

; The folder under %LOCALAPPDATA% that holds the person's data. It is
; APP_DIR_NAME in src/app-paths.ts; src/packaging.spec.ts holds the two equal.
!define MONIZE_DATA_DIR_NAME "Monize"

; Silent uninstall (/S) keeps the data unless this switch is given.
!define MONIZE_REMOVE_DATA_SWITCH "--remove-data"

; "Move data folder" (src/move/) records where the data went in a file beside
; the default data folder: <default data folder>-location.ini, an INI file in
; UTF-16, which ReadINIStr reads as Unicode. A move that is under way keeps
; its journal beside it. src/packaging.spec.ts holds these names, and the
; names of what the application creates in a data folder, equal to the
; application's own.
!define MONIZE_LOCATION_SUFFIX "-location.ini"
!define MONIZE_JOURNAL_SUFFIX "-move.json"
!define MONIZE_LOCATION_SECTION "location"
; What makes a folder a Monize data folder: its config.json and, in its
; database folder, the marker the application writes once initdb has finished.
!define MONIZE_INIT_MARKER "monize.initialized"

!define UNINSTALL_SECTION_NAME "Remove Monize"
!define MONIZE_TXT_REMOVE_DATA "Remove my data (%LOCALAPPDATA%\${MONIZE_DATA_DIR_NAME}, or the folder it was moved to)"

!define MUI_DIRECTORYPAGE_TEXT_TOP "Setup will install $(^NameDA) in the following folder. Choose a new or empty folder: the folder that holds your Monize data cannot be used. $_CLICK"

!define MONIZE_TXT_DIR_IS_DATA "Monize cannot be installed in:$\r$\n$INSTDIR$\r$\n$\r$\nThat folder is, contains, or is inside the folder where Monize keeps your data:$\r$\n$monizeDataDirHit$\r$\n$\r$\nUpdating or uninstalling Monize deletes everything in its installation folder, so your data would be lost. Run Setup again and choose another folder."
!define MONIZE_TXT_DIR_NOT_EMPTY "Monize cannot be installed in:$\r$\n$INSTDIR$\r$\n$\r$\nThat folder already contains other files. Updating or uninstalling Monize deletes everything in its installation folder. Run Setup again and choose a new or empty folder."
!define MONIZE_TXT_UNINSTALL_HOLDS_DATA "Nothing was removed.$\r$\n$\r$\nThe installation folder holds Monize's data:$\r$\n$INSTDIR$\r$\n$\r$\nRemoving the application would delete that data. Copy the folder somewhere safe, then delete it by hand."
!define MONIZE_TXT_PER_USER_ONLY "Monize installs for the current user only; /allusers is not supported."

; ---------------------------------------------------------------------------
; Settings
; ---------------------------------------------------------------------------

; How long `Monize.exe --quit` may take. The application gives up waiting for
; itself after 120 seconds (QUIT_WAIT_MS in src/shell/quit-wait.ts); this is
; the installer's own bound in case the process never returns.
!define MONIZE_QUIT_TIMEOUT_MS 130000
; After that, how many one-second looks to give helper processes that are
; still on their way out before anything is terminated.
!define MONIZE_SETTLE_TRIES 5
; And how many rounds of terminating before the person is asked to step in.
!define MONIZE_KILL_TRIES 5

!ifdef BUILD_UNINSTALLER
  !define MONIZE_UN "un."
!else
  !define MONIZE_UN ""
!endif

Var monizeDataDir     ; %LOCALAPPDATA%\Monize as the application resolves it
Var monizeDataDirAlt  ; the same from Windows' own folder table, when it differs
Var monizeDataDirMoved ; where "Move data folder" put the data, when it did
Var monizeDataDirPrev  ; the copy that move left behind, until it is deleted
Var monizeDataDirHit  ; set by MonizeRelationToData: the data folder it found
Var pid               ; this process; electron-builder's KILL_PROCESS spares it

; ---------------------------------------------------------------------------
; Paths
; ---------------------------------------------------------------------------

; Stack: path -> the same path in one comparable form: absolute, no "..",
; forward slashes or trailing backslash, and with long names for as much of it
; as exists, so that an 8.3 alias of a folder compares equal to its real name.
Function ${MONIZE_UN}MonizeNormalizePath
  Exch $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5

  System::Call 'kernel32::GetFullPathNameW(w r0, i ${NSIS_MAX_STRLEN}, w .r1, p 0) i .r2'
  ${If} $2 <> 0
    StrCpy $0 $1
  ${EndIf}

  ${Do}
    StrLen $2 $0
    StrCpy $1 $0 1 -1
    ${If} $2 <= 3
    ${OrIf} $1 != "\"
      ${Break}
    ${EndIf}
    StrCpy $0 $0 -1
  ${Loop}

  ; $3 = the part tried so far, $4 = what was cut off its end
  StrCpy $3 $0
  StrCpy $4 ""
  ${Do}
    System::Call 'kernel32::GetLongPathNameW(w r3, w .r1, i ${NSIS_MAX_STRLEN}) i .r2'
    ${If} $2 <> 0
      StrCpy $0 "$1$4"
      ${Break}
    ${EndIf}
    ; cut the last name off: $5 = the position of its backslash
    StrLen $5 $3
    ${Do}
      IntOp $5 $5 - 1
      StrCpy $2 $3 1 $5
      ${If} $2 == "\"
      ${OrIf} $5 <= 2
        ${Break}
      ${EndIf}
    ${Loop}
    ${If} $5 <= 2
      ${Break}
    ${EndIf}
    StrCpy $2 $3 "" $5
    StrCpy $4 "$2$4"
    StrCpy $3 $3 $5
  ${Loop}

  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Exch $0
FunctionEnd

; Stack: a default data folder (normalised; may be empty). Reads the pointer
; beside it into $monizeDataDirMoved and $monizeDataDirPrev, unless an earlier
; call already found one. A missing file or key leaves them empty.
Function ${MONIZE_UN}MonizeReadLocation
  Exch $0
  Push $1
  ${If} $0 != ""
  ${AndIf} $monizeDataDirMoved == ""
  ${AndIf} ${FileExists} "$0${MONIZE_LOCATION_SUFFIX}"
    ReadINIStr $1 "$0${MONIZE_LOCATION_SUFFIX}" "${MONIZE_LOCATION_SECTION}" "dataDir"
    ${If} $1 != ""
      Push $1
      Call ${MONIZE_UN}MonizeNormalizePath
      Pop $monizeDataDirMoved
    ${EndIf}
    ReadINIStr $1 "$0${MONIZE_LOCATION_SUFFIX}" "${MONIZE_LOCATION_SECTION}" "previousDataDir"
    ${If} $1 != ""
      Push $1
      Call ${MONIZE_UN}MonizeNormalizePath
      Pop $monizeDataDirPrev
    ${EndIf}
    ClearErrors
  ${EndIf}
  Pop $1
  Pop $0
FunctionEnd

; Sets $monizeDataDir and $monizeDataDirAlt. The application reads the
; LOCALAPPDATA environment variable (src/app-paths.ts), so that is the first
; answer; Windows' own answer for the current user is kept as a second one
; when the two differ. Both are empty when neither is known. Also sets
; $monizeDataDirMoved and $monizeDataDirPrev from the pointer that "Move data
; folder" leaves beside the default folder; both are empty for an install
; that never moved its data.
Function ${MONIZE_UN}MonizeFindDataDir
  Push $0
  Push $1
  StrCpy $monizeDataDir ""
  StrCpy $monizeDataDirAlt ""
  StrCpy $monizeDataDirMoved ""
  StrCpy $monizeDataDirPrev ""

  ReadEnvStr $0 LOCALAPPDATA
  ${If} $0 != ""
    Push "$0\${MONIZE_DATA_DIR_NAME}"
    Call ${MONIZE_UN}MonizeNormalizePath
    Pop $monizeDataDir
  ${EndIf}

  ; CSIDL_LOCAL_APPDATA, whatever SetShellVarContext says
  StrCpy $0 ""
  System::Call 'shell32::SHGetFolderPathW(p 0, i 0x1c, p 0, i 0, w .r0) i .r1'
  ${If} $1 == 0
  ${AndIf} $0 != ""
    Push "$0\${MONIZE_DATA_DIR_NAME}"
    Call ${MONIZE_UN}MonizeNormalizePath
    Pop $0
    ${If} $monizeDataDir == ""
      StrCpy $monizeDataDir $0
    ${ElseIf} $monizeDataDir != $0
      StrCpy $monizeDataDirAlt $0
    ${EndIf}
  ${EndIf}

  Push $monizeDataDir
  Call ${MONIZE_UN}MonizeReadLocation
  Push $monizeDataDirAlt
  Call ${MONIZE_UN}MonizeReadLocation

  Pop $1
  Pop $0
FunctionEnd

; Stack: A, B (both normalised; B on top) -> how folder A stands to folder B:
; "same", "inside" (A is under B), "contains" (B is under A) or "" (apart, or
; either is unknown). Names compare without regard to case, as Windows does.
Function ${MONIZE_UN}MonizeRelation
  Exch $1
  Exch
  Exch $0
  Push $2
  Push $3
  Push $4

  StrCpy $4 ""
  ${If} $0 != ""
  ${AndIf} $1 != ""
    ${If} $0 == $1
      StrCpy $4 "same"
    ${Else}
      ; compare whole names: "C:\a\Monize" is not inside "C:\a\Mon"
      StrCpy $2 $0 1 -1
      ${If} $2 != "\"
        StrCpy $0 "$0\"
      ${EndIf}
      StrCpy $2 $1 1 -1
      ${If} $2 != "\"
        StrCpy $1 "$1\"
      ${EndIf}
      StrLen $2 $1
      StrCpy $3 $0 $2
      ${If} $3 == $1
        StrCpy $4 "inside"
      ${Else}
        StrLen $2 $0
        StrCpy $3 $1 $2
        ${If} $3 == $0
          StrCpy $4 "contains"
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ; The stack holds, from the top: $4, $3, $2, the caller's $0, the caller's
  ; $1. Both registers go back to the caller as they were, and the answer is
  ; left on the stack. (Restoring them crosswise, as this once did, made
  ; every comparison after the first in MonizeRelationToData compare the
  ; wrong folder.)
  StrCpy $0 $4
  Pop $4
  Pop $3
  Pop $2
  Exch $0
  Exch
  Pop $1
FunctionEnd

; In MonizeRelationToData: $0 = the folder, $1 = the answer so far. Tries one
; more data folder while there is no answer yet.
!macro monizeTryRelation CANDIDATE
  ${If} $1 == ""
    Push $0
    Push ${CANDIDATE}
    Call ${MONIZE_UN}MonizeRelation
    Pop $1
    ${If} $1 != ""
      StrCpy $monizeDataDirHit ${CANDIDATE}
    ${EndIf}
  ${EndIf}
!macroend

; Stack: folder -> how it stands to a folder that holds the person's data, as
; MonizeRelation says: the default data folder (either answer for it), the
; folder the data was moved to, or the copy a move left behind. Sets
; $monizeDataDirHit to the one it found, and the variables MonizeFindDataDir
; sets.
Function ${MONIZE_UN}MonizeRelationToData
  Exch $0
  Push $1
  Call ${MONIZE_UN}MonizeFindDataDir
  Push $0
  Call ${MONIZE_UN}MonizeNormalizePath
  Pop $0
  StrCpy $monizeDataDirHit ""
  StrCpy $1 ""
  !insertmacro monizeTryRelation $monizeDataDir
  !insertmacro monizeTryRelation $monizeDataDirAlt
  !insertmacro monizeTryRelation $monizeDataDirMoved
  !insertmacro monizeTryRelation $monizeDataDirPrev
  StrCpy $0 $1
  Pop $1
  Exch $0
FunctionEnd

; ---------------------------------------------------------------------------
; Installer: where Monize may be installed
; ---------------------------------------------------------------------------

!ifndef BUILD_UNINSTALLER

; Stack: folder -> why Monize must not be installed there: "data", "notempty"
; or "" when it may.
;
; "data": the folder is, contains, or is inside %LOCALAPPDATA%\Monize, or
; the folder the data was moved to, or the copy a move left behind. The
; uninstaller deletes the installation folder with everything in it, on every
; update as well as on an uninstall, so this is the one way the installer
; could destroy the person's financial data. The directory page appends the
; product name to whatever is chosen, so choosing %LOCALAPPDATA% itself yields
; exactly the data folder.
;
; "notempty": the folder exists, holds something, and is not a Monize
; installation. The same deletion would take those files with it; and a data
; folder reached under another name (a junction, a mapped drive) is refused
; here by its contents.
Function MonizeInstDirProblem
  Exch $0
  Push $1
  Push $2
  Push $3

  StrCpy $3 ""
  Push $0
  Call MonizeRelationToData
  Pop $1
  ${If} $1 != ""
    StrCpy $3 "data"
  ${ElseIf} ${FileExists} "$0\*.*"
  ; (the template's APP_EXECUTABLE_FILENAME and UNINSTALL_FILENAME, which
  ; are not defined yet where this file is included)
  ${AndIfNot} ${FileExists} "$0\${PRODUCT_FILENAME}.exe"
  ${AndIfNot} ${FileExists} "$0\Uninstall ${PRODUCT_FILENAME}.exe"
    FindFirst $1 $2 "$0\*.*"
    ${DoWhile} $2 != ""
      ${If} $2 != "."
      ${AndIf} $2 != ".."
        StrCpy $3 "notempty"
        ${Break}
      ${EndIf}
      FindNext $1 $2
    ${Loop}
    FindClose $1
  ${EndIf}

  StrCpy $0 $3
  Pop $3
  Pop $2
  Pop $1
  Exch $0
FunctionEnd

!macro monizeDefineVerifyInstDir
  ; Runs each time the folder on the directory page changes; Abort greys out
  ; Next. The page's own text says which folders are refused. This is a
  ; convenience: the check that decides is monizeRefuseBadInstDir, which also
  ; covers a silent install and /D=.
  Function .onVerifyInstDir
    Push $0
    Push $1
    ; The folder the installation would use: the template's instFilesPre
    ; appends the product name unless the path already contains it.
    StrCpy $1 $INSTDIR
    ${StrContains} $0 "${APP_FILENAME}" $1
    ${If} $0 == ""
      StrCpy $1 "$1\${APP_FILENAME}"
    ${EndIf}
    Push $1
    Call MonizeInstDirProblem
    Pop $0
    ${If} $0 != ""
      Pop $1
      Pop $0
      Abort
    ${EndIf}
    Pop $1
    Pop $0
  FunctionEnd
!macroend

!macro monizeRefuseBadInstDir
  Push $INSTDIR
  Call MonizeInstDirProblem
  Pop $R0
  ${If} $R0 == "data"
    MessageBox MB_OK|MB_ICONSTOP "${MONIZE_TXT_DIR_IS_DATA}" /SD IDOK
    SetErrorLevel 2
    Quit
  ${ElseIf} $R0 == "notempty"
    MessageBox MB_OK|MB_ICONSTOP "${MONIZE_TXT_DIR_NOT_EMPTY}" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!endif ; installer

; ---------------------------------------------------------------------------
; Both: stop a running Monize before its files are touched
; ---------------------------------------------------------------------------

; Nothing here needs to know where the data folder is: `Monize.exe --quit`
; resolves it as every launch does (MONIZE_DATA_DIR, the pointer of a moved
; folder, the default), so it reaches the running application, and a
; PostgreSQL left behind, wherever the data was moved to.
;
; First the clean way: `Monize.exe --quit` asks the running application to
; stop its frontend, backend and PostgreSQL, and returns when that process has
; gone; when none is running it shuts down a PostgreSQL that a killed Monize
; left behind (src/electron-main.ts). Then electron-builder's own machinery
; as the fallback: FIND_PROCESS and KILL_PROCESS look for, and terminate, the
; processes whose executable is under $INSTDIR (through PowerShell; without
; PowerShell they go by the image name Monize.exe for the current user).
; Terminating is a crash stop for PostgreSQL, which recovers from it on the
; next start, so it comes last and, in an interactive run, only after asking.
!macro monizeStopRunningApp
  System::Call 'kernel32::GetCurrentProcessId() i .s'
  Pop $pid

  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    DetailPrint "$(appClosing)"
    nsExec::Exec /TIMEOUT=${MONIZE_QUIT_TIMEOUT_MS} '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit'
    Pop $R0 ; its exit code, "timeout" or "error": the look below decides
  ${EndIf}

  !insertmacro IS_POWERSHELL_AVAILABLE
  StrCpy $R1 0
  monize_look:
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 == 0
      IntOp $R1 $R1 + 1
      ${If} $R1 <= ${MONIZE_SETTLE_TRIES}
        Sleep 1000
        Goto monize_look
      ${EndIf}
      IntOp $R2 ${MONIZE_SETTLE_TRIES} + 1
      ${If} $R1 == $R2
      ${AndIfNot} ${isUpdated}
        MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK monize_terminate
        SetErrorLevel 2
        Quit
      ${EndIf}
      monize_terminate:
      IntOp $R2 ${MONIZE_SETTLE_TRIES} + ${MONIZE_KILL_TRIES}
      ${If} $R1 > $R2
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY monize_again
        SetErrorLevel 2
        Quit
        monize_again:
        IntOp $R1 ${MONIZE_SETTLE_TRIES} + 1
      ${EndIf}
      !insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 1
      Sleep 1000
      Goto monize_look
    ${EndIf}
!macroend

; ---------------------------------------------------------------------------
; The hooks
; ---------------------------------------------------------------------------

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    !insertmacro monizeDefineVerifyInstDir
  !endif
!macroend

!macro customInit
  ; A per-machine install runs elevated, possibly as another account, whose
  ; %LOCALAPPDATA% is not the one that holds the person's data.
  ${If} $installMode == "all"
    MessageBox MB_OK|MB_ICONSTOP "${MONIZE_TXT_PER_USER_ONLY}" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    !insertmacro monizeRefuseBadInstDir
  !endif
  !insertmacro monizeStopRunningApp
!macroend

!macro customUnInstall
  ; The last line of defence for the data: never delete an installation
  ; folder that is, or contains, the data folder, or that holds a database.
  ; Such an installation predates the installer's own refusal or was reached
  ; under another name. The installer treats this exit code as a failed
  ; uninstall and stops, so an update fails safe as well.
  Push $INSTDIR
  Call un.MonizeRelationToData
  Pop $R0
  ${If} $R0 == "same"
  ${OrIf} $R0 == "contains"
  ${OrIf} ${FileExists} "$INSTDIR\pgdata\PG_VERSION"
    MessageBox MB_OK|MB_ICONSTOP "${MONIZE_TXT_UNINSTALL_HOLDS_DATA}" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}

  ${IfNot} ${isUpdated}
    ; The application registers monize:// itself on first run. Remove the
    ; registration when it points at the executable being removed.
    ReadRegStr $R0 HKCU "Software\Classes\monize\shell\open\command" ""
    StrLen $R1 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
    StrCpy $R2 $R0 $R1
    ${If} $R2 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
      DeleteRegKey HKCU "Software\Classes\monize"
    ${EndIf}

    ; The copy of the installer that electron-builder keeps for updates.
    !ifdef APP_INSTALLER_STORE_FILE
      Push $R3
      System::Call 'shell32::SHGetFolderPathW(p 0, i 0x1c, p 0, i 0, w .R3) i .R0'
      ${If} $R0 == 0
      ${AndIf} $R3 != ""
        Delete "$R3\${APP_INSTALLER_STORE_FILE}"
        RMDir /r "$R3\${APP_PACKAGE_NAME}-updater\pending"
        RMDir "$R3\${APP_PACKAGE_NAME}-updater"
      ${EndIf}
      Pop $R3
    !endif
  ${EndIf}
!macroend

!macro customUnInstallSection
  ; The checkbox: an optional section, unticked (/o), on the uninstaller's
  ; components page. NSIS runs it only when it is ticked, and never in a
  ; silent run, where nothing can tick it.
  Section /o "un.${MONIZE_TXT_REMOVE_DATA}"
    Call un.MonizeRemoveData
  SectionEnd

  ; A silent uninstall keeps the data unless it is run with --remove-data.
  Section "-un.MonizeRemoveDataSwitch"
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "${MONIZE_REMOVE_DATA_SWITCH}" $R1
    ${IfNot} ${Errors}
      Call un.MonizeRemoveData
    ${EndIf}
  SectionEnd

  Function un.MonizeRemoveData
    ; An update runs the old uninstaller; it must never remove data, whatever
    ; else it was asked.
    ${If} ${isUpdated}
      Return
    ${EndIf}
    Push $0
    Push $1
    Call un.MonizeFindDataDir
    Push $monizeDataDir
    Call un.MonizeRemoveDataFolder
    Push $monizeDataDirAlt
    Call un.MonizeRemoveDataFolder
    ; A data folder that was moved, and the copy the move left behind.
    Push $monizeDataDirMoved
    Call un.MonizeRemoveMovedFolder
    Push $monizeDataDirPrev
    Call un.MonizeRemoveMovedFolder
    ; With the data gone, the record of where it was goes too: left behind,
    ; it would stop a later installation from starting.
    ${If} $monizeDataDir != ""
      Delete "$monizeDataDir${MONIZE_LOCATION_SUFFIX}"
      Delete "$monizeDataDir${MONIZE_JOURNAL_SUFFIX}"
    ${EndIf}
    ${If} $monizeDataDirAlt != ""
      Delete "$monizeDataDirAlt${MONIZE_LOCATION_SUFFIX}"
      Delete "$monizeDataDirAlt${MONIZE_JOURNAL_SUFFIX}"
    ${EndIf}
    Pop $1
    Pop $0
  FunctionEnd

  ; Stack: folder. A moved data folder is wherever the person chose, under
  ; whatever name, so it is recognised by what it holds, and only what the
  ; application created in it is deleted (OWNED_TOP_LEVEL and TOMBSTONE_FILE
  ; in src/move/layout.ts): a file the person put there stays, and the folder
  ; with it. The two things that identify the folder go last, so a deletion
  ; that is interrupted can be repeated. Does nothing for anything else.
  Function un.MonizeRemoveMovedFolder
    Exch $0
    Push $1
    StrLen $1 $0
    ${If} $1 > 3
    ${AndIf} ${FileExists} "$0\config.json"
    ${AndIf} ${FileExists} "$0\pgdata\${MONIZE_INIT_MARKER}"
      SetOutPath $TEMP
      RMDir /r "$0\backups"
      RMDir /r "$0\attachments"
      RMDir /r "$0\logs"
      RMDir /r "$0\shell"
      Delete "$0\moved-elsewhere.json"
      Delete "$0\pgdata.initdb-password"
      RMDir /r "$0\pgdata"
      Delete "$0\config.json"
      RMDir "$0"
    ${EndIf}
    Pop $1
    Pop $0
  FunctionEnd

  ; Stack: folder. Deletes it when it is a folder of the expected name below
  ; a drive and a parent ("X:\a\Monize" at the least), and does nothing for
  ; anything else, an empty string included.
  Function un.MonizeRemoveDataFolder
    Exch $0
    Push $1
    Push $2
    StrLen $1 "\${MONIZE_DATA_DIR_NAME}"
    StrCpy $2 $0 "" -$1
    StrLen $1 $0
    ${If} $2 == "\${MONIZE_DATA_DIR_NAME}"
    ${AndIf} $1 > 12
    ${AndIf} ${FileExists} "$0\*.*"
      SetOutPath $TEMP
      RMDir /r "$0"
    ${EndIf}
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd
!macroend

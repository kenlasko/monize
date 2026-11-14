; A minimal stand-in for electron-builder's NSIS template, for checking
; build/installer.nsh off Windows. It defines what the template defines and
; inserts each hook where the template does, so the file compiles as both
; the installer and the uninstaller with warnings as errors:
;
;   makensis -WX -DNSH=<abs path>/build/installer.nsh -DOUT=<file>.exe \
;            [-DBUILD_UNINSTALLER] scripts/installer-harness.nsi
;
; The two programs it produces also run (under Wine, for one): the first
; refuses a /D= folder as the real installer does (exit code 2); the second,
; run with /S, writes "Uninstall Monize.exe", whose --remove-data is the real
; one. desktop/README.md, "Checking installer.nsh off Windows", has the steps.
; It proves syntax and the logic of the hooks, not electron-builder's own
; template around them.
Unicode true
Name "MonizeHarness"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\Programs\Monize"
RequestExecutionLevel user
; As the template's common.nsh does, ahead of customHeader.
ShowInstDetails nevershow

!define PRODUCT_FILENAME "Monize"
!define APP_FILENAME "Monize"
!define APP_EXECUTABLE_FILENAME "Monize.exe"
!define APP_PACKAGE_NAME "monize-desktop"
!define APP_INSTALLER_STORE_FILE "monize-desktop-updater\installer.exe"

Var installMode
Var isForceCurrentInstall
Var harnessUpdated

!include LogicLib.nsh
!macro _HarnessUpdated _a _b _t _f
  StrCmp $harnessUpdated "1" `${_t}` `${_f}`
!macroend
!define isUpdated `"" HarnessUpdated ""`
!macro HarnessStrContains OUT NEEDLE HAYSTACK
  StrCpy ${OUT} ""
!macroend
!define StrContains "!insertmacro HarnessStrContains"
!macro IS_POWERSHELL_AVAILABLE
!macroend
!macro FIND_PROCESS NAME OUT
  StrCpy ${OUT} 1
!macroend
!macro KILL_PROCESS NAME FORCE
!macroend
LangString appClosing 1033 "closing"
LangString appRunning 1033 "running"
LangString appCannotBeClosed 1033 "cannot be closed"

!include "${NSH}"

Page directory
Page instfiles
UninstPage components
UninstPage instfiles

!insertmacro customHeader

!ifndef BUILD_UNINSTALLER
  Function .onInit
    StrCpy $installMode "current"
    StrCpy $harnessUpdated "0"
    !insertmacro customInit
    !insertmacro customInstallMode
  FunctionEnd
  Section "Main"
    ; As the template's installSection.nsh does, ahead of the first hook.
    ${IfNot} ${Silent}
      SetDetailsPrint none
    ${EndIf}
    !insertmacro customCheckAppRunning
    !insertmacro customInstall
  SectionEnd
!else
  Section "Main"
    SetOutPath $INSTDIR
    WriteUninstaller "$INSTDIR\Uninstall Monize.exe"
  SectionEnd
  Function .onInit
    StrCpy $installMode "current"
    StrCpy $isForceCurrentInstall "1"
  FunctionEnd
  Function un.onInit
    StrCpy $harnessUpdated "0"
  FunctionEnd
  Section "un.Main"
    !insertmacro customCheckAppRunning
    !insertmacro customUnInstall
  SectionEnd
  !insertmacro customUnInstallSection
!endif

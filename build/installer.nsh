; Custom NSIS additions for Nucleus (wired up as `nsis.include` in package.json).
;
; Why this file exists
; --------------------
; electron-builder writes the app package through the silent copy/rename macros in
; templates/nsis/include/installUtil.nsh - `CopyFiles /SILENT` and `Rename` all run
; under `ClearErrors`, so a target directory that cannot be created or written never
; complains. The first operation that hard-fails is the very last statement of
; installApplicationFiles (templates/nsis/include/installer.nsh:100):
;
;     File "/oname=${UNINSTALL_FILENAME}" "${UNINSTALLER_OUT_FILE}"
;
; which surfaces as the stock NSIS "Error opening file for writing:
; ...\AppData\Local\Programs\nucleus\Uninstall Nucleus.exe"
; Abort / Retry / Ignore dialog. Both of the useful-looking buttons are traps:
;
;   * Retry can never succeed - by then $INSTDIR may not exist at all, and nothing
;     at that point in the script re-creates it.
;   * Ignore completes the install *without* the uninstaller but *with* the
;     Add/Remove Programs entry (registryAddInstallInfo runs right after), so the
;     app looks installed and cannot be uninstalled.
;
; `customInit` is inserted into Function .onInit (templates/nsis/installer.nsi:79)
; after initMultiUser has settled $INSTDIR and before any payload is written - the
; last moment where this class of failure can still be fixed rather than reported.
;
; The realistic causes on a clean machine are (a) third-party real-time protection
; guarding %LOCALAPPDATA%\Programs - an unsigned NSIS stub dropping a freshly
; generated .exe into that folder is exactly the persistence behaviour those shields
; target - and (b) a leftover process holding a handle on the old uninstaller, which
; electron-builder's own CHECK_APP_RUNNING does not look for, because it only knows
; about "${APP_EXECUTABLE_FILENAME}"
; (templates/nsis/include/allowOnlyOneInstallerInstance.nsh:105-164).
;
; taskkill is not part of a normal install. It runs only after the user confirms
; that a locked uninstaller should be closed.


!macro RW_KILL_UNINSTALLER_HOLDERS
  ; A stalled "Uninstall Nucleus.exe" - from a cancelled or still-draining
  ; uninstall - keeps the file we are about to overwrite locked. Called only
  ; after the user asks us to close it. Safe to force: this Setup process is
  ; "Nucleus Setup <version>.exe", so taskkill cannot hit us; the app
  ; itself is left to the built-in CHECK_APP_RUNNING prompt, which asks the
  ; user before closing it. Output is discarded because "no such process" is
  ; the normal, healthy answer.
  ExecWait '$SYSDIR\cmd.exe /C taskkill /F /IM "Uninstall ${PRODUCT_FILENAME}.exe" >NUL 2>&1'
!macroend


!macro RW_UNLOCK_UNINSTALLER
  ; Fresh installs have no uninstaller to replace. An upgrade whose uninstaller
  ; is not running opens for append (we do not truncate it). A locked file asks
  ; once: Retry closes that process and tries again; Cancel aborts before any
  ; payload is written.
  IfFileExists "$INSTDIR\Uninstall ${PRODUCT_FILENAME}.exe" 0 rw_unlock_done
    ClearErrors
    FileOpen $R7 "$INSTDIR\Uninstall ${PRODUCT_FILENAME}.exe" a
    ${IfNot} ${Errors}
      FileClose $R7
      Goto rw_unlock_done
    ${EndIf}

    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "The previous uninstaller is still open, so Nucleus cannot replace it:$\r$\n$INSTDIR\Uninstall ${PRODUCT_FILENAME}.exe$\r$\n$\r$\nNothing has been installed yet.$\r$\n$\r$\nRetry closes that uninstaller and continues. Cancel leaves the current install untouched." IDRETRY rw_unlock_kill
      Abort

    rw_unlock_kill:
      !insertmacro RW_KILL_UNINSTALLER_HOLDERS
      Sleep 500
      ClearErrors
      FileOpen $R7 "$INSTDIR\Uninstall ${PRODUCT_FILENAME}.exe" a
      ${IfNot} ${Errors}
        FileClose $R7
        Goto rw_unlock_done
      ${EndIf}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Nucleus still cannot replace the uninstaller. Close Uninstall ${PRODUCT_FILENAME}.exe yourself, then run Setup again. Nothing has been installed."
      Abort

  rw_unlock_done:
!macroend


!macro RW_ENSURE_WRITABLE
  ; Create $INSTDIR and prove that it actually accepts a write, before the
  ; 250 MB payload has been half-laid down. The retry loop matters: a folder an
  ; antivirus has just removed can linger in delete-pending for a few seconds
  ; while some other process (Explorer, an indexer, the scanner itself) still
  ; holds a handle inside it, and during that window CreateDirectory fails even
  ; though it would succeed moments later.
  StrCpy $R6 0
  rw_writable_loop:
    IntOp $R6 $R6 + 1

    ClearErrors
    CreateDirectory "$INSTDIR"

    ${IfNot} ${Errors}
      ; The directory existing is not the same as it being writable.
      ClearErrors
      FileOpen $R7 "$INSTDIR\.rw-write-probe" w
      ${IfNot} ${Errors}
        FileClose $R7
        Delete "$INSTDIR\.rw-write-probe"
        Goto rw_writable_done
      ${EndIf}
    ${EndIf}

    Sleep 750

    ${If} $R6 < 14
      Goto rw_writable_loop
    ${EndIf}

    ; Roughly ten seconds of futility. Tell the user what to do instead of
    ; handing them a dialog whose buttons both make things worse.
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Nucleus cannot write to:$\r$\n$INSTDIR$\r$\n$\r$\nNothing has been installed yet, so nothing is left half-broken.$\r$\n$\r$\nReal-time protection (Malwarebytes, Windows Defender's ransomware protection, and similar) commonly blocks this folder for unsigned installers: an NSIS setup creating an .exe under AppData\Local\Programs is the behaviour those shields target, not a property of this app.$\r$\n$\r$\nAllow-list this installer and the folder above, then press Retry.$\r$\n$\r$\nCancel to bail out; the unpacked build in dist\win-unpacked and the portable .exe both run without an installer." IDRETRY rw_writable_loop
      Abort

  rw_writable_done:
!macroend


; The product was "Radial Wheel" before the rename to Nucleus.


!macro RW_UNINSTALL_LEGACY
  ; Radial Wheel -> Nucleus rename: silently remove the previously installed
  ; product (its own uninstaller, then its folder), and drop its orphaned
  ; login-item + AUMID registrations. The old profile (%APPDATA%\Radial Wheel)
  ; is left in place — src/main/migrate.js copies it into %APPDATA%\Nucleus
  ; on first launch, and the folder stays for rollback.
  IfFileExists "$LOCALAPPDATA\Programs\radial-wheel\Uninstall Radial Wheel.exe" 0 rw_legacy_runkey
    ; Close the old app if it is still running (its exe name differs from the
    ; new one, so CHECK_APP_RUNNING would not catch it). Output discarded:
    ; "no such process" is the normal answer.
    ExecWait '$SYSDIR\cmd.exe /C taskkill /F /IM "Radial Wheel.exe" >NUL 2>&1'
    ; _?= keeps the uninstaller running from its own folder (no temp copy) so
    ; the RMDir below can remove everything it owned.
    ExecWait '"$LOCALAPPDATA\Programs\radial-wheel\Uninstall Radial Wheel.exe" /S _?=$LOCALAPPDATA\Programs\radial-wheel'
    RMDir /r "$LOCALAPPDATA\Programs\radial-wheel"
  rw_legacy_runkey:
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "local.radialwheel"
    DeleteRegKey /ifempty HKCU "Software\Classes\AppUserModelId\local.radialwheel"
!macroend


!macro customInit
  ; If the target file exists but is locked rather than missing, "try" mode has
  ; NSIS rename the old one aside and write a fresh file, which is what a busy
  ; uninstaller needs. (The electron-builder templates never set SetOverwrite,
  ; so this is stated rather than assumed.)
  SetOverwrite try

  !insertmacro RW_UNINSTALL_LEGACY
  !insertmacro RW_ENSURE_WRITABLE
  !insertmacro RW_UNLOCK_UNINSTALLER
!macroend

; Parentix — Windows installer additions.
;
; The problem this file exists to solve, stated plainly:
;
;   Website blocking needs `Set-DnsClientServerAddress`, which needs an
;   administrator. The obvious answer — mark the application
;   `requireAdministrator` — is wrong twice over. It puts a UAC prompt in front
;   of a child every time they sign in, and Windows will not auto-start an
;   elevated application from the Run key *at all*, so the agent would simply
;   never start on its own.
;
; The standard Windows answer is a scheduled task that runs at logon with the
; highest privileges the account has. The installer is already elevated, so it
; can create one; the task then starts the agent silently, elevated, with no
; prompt. The application manifest stays `asInvoker`, so a manual launch is an
; ordinary unprivileged one and degrades to "no website filtering", which the
; permissions screen states rather than hides.
;
; INSTALL AS THE CHILD. The task is created for the account running the
; installer, because that is the account whose logon it has to trigger on. A
; parent installing from their own account gets a task on *their* logon, which is
; not what anybody wanted. The documented flow is: sign in as the child, run the
; installer, enter the administrator password at the UAC prompt.
;
; Everything here is best-effort. A machine where the task cannot be created — a
; policy that forbids it, an account with no logon right — still gets a working
; agent through the ordinary login item; it just runs unelevated, and says so.

!macro customInstall
  DetailPrint "Registering the Parentix agent to start at sign-in…"
  nsExec::ExecToLog 'schtasks /Create /F /RL HIGHEST /SC ONLOGON /RU "%USERDOMAIN%\%USERNAME%" /TN "Parentix Child Agent" /TR "$\"$INSTDIR\Parentix.exe$\" --parentix-autostart"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Could not register the sign-in task (code $0). Parentix will still run, without website filtering."
  ${EndIf}
!macroend

!macro customUnInstall
  ; An uninstall is the one path with no next startup, so the resolver has to be
  ; put back here — `repairSystemDns` will never get the chance.
  ;
  ; This resets every interface to DHCP rather than reading `dns-backup.json` and
  ; restoring exactly what was there. That is a deliberate simplification of the
  ; agent's own restore, and the trade is worth stating: a household that had set
  ; its own resolver by hand will find it back on the ISP's after an uninstall.
  ; The alternative is parsing JSON inside an NSIS-escaped PowerShell one-liner
  ; running against a directory the uninstaller may already have emptied — more
  ; ways to fail, on the path whose entire job is to be the one that does not.
  ; The agent's ordinary shutdown restores statics correctly; this is the
  ; backstop for when that did not happen.
  ;
  ; Backtick-quoted, because NSIS accepts three quote characters and this line
  ; needs all of them: backtick for NSIS, double for `-Command`, single for the
  ; address inside PowerShell. `$$` is how a literal `$` survives NSIS.
  DetailPrint "Restoring this computer's DNS settings…"
  nsExec::ExecToLog `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-DnsClientServerAddress | Where-Object { $$_.ServerAddresses -contains '127.0.0.1' -or $$_.ServerAddresses -contains '::1' } | ForEach-Object { Set-DnsClientServerAddress -InterfaceIndex $$_.InterfaceIndex -ResetServerAddresses -ErrorAction SilentlyContinue }; Clear-DnsClientCache"`

  nsExec::ExecToLog 'schtasks /Delete /F /TN "Parentix Child Agent"'
!macroend

import { ps, psJson } from './powershell.js';

/**
 * Closing an application the parent has paused.
 *
 * Android draws over a blocked app and leaves it running. Windows has no
 * equivalent, so the app is closed — which makes the deny-list below the most
 * important thing in this file.
 *
 * **A rule is a string a parent typed.** The form offers the apps this machine
 * has reported, but the field is still free text, and a parent who blocks
 * `explorer.exe` because they saw it in a list has just asked the agent to take
 * the desktop away. Worse are the ones that would bugcheck the machine outright:
 * terminating `csrss.exe`, `wininit.exe`, `services.exe` or `lsass.exe` is a
 * blue screen, not an error message. None of those is a thing a parental control
 * should be capable of doing on any input, so the guard is here rather than in
 * validation somewhere upstream.
 *
 * **The close is asked for before it is forced.** `CloseMainWindow` is a WM_CLOSE
 * — the same thing clicking the X does — so an editor gets to write its
 * recovery file. Four seconds later, whatever is left is terminated, because an
 * app that puts up "Save changes?" and waits is otherwise a way to keep a
 * blocked app open indefinitely.
 */

/**
 * Processes this agent will not touch, whatever a rule says.
 *
 * The shell and the login stack, the kernel-critical set, the security
 * subsystem, and Parentix itself — an agent that can be told to close itself is
 * an agent a child can switch off with one rule they talk their parent into.
 */
const PROTECTED = new Set([
  'system', 'idle', 'registry', 'memory compression',
  'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'lsaiso', 'smss',
  'svchost', 'dwm', 'fontdrvhost', 'sihost', 'ctfmon', 'taskhostw',
  'explorer', 'searchhost', 'shellexperiencehost', 'startmenuexperiencehost',
  'applicationframehost', 'textinputhost', 'runtimebroker',
  'lockapp', 'logonui', 'userinit',
  'msmpeng', 'securityhealthservice', 'securityhealthsystray',
  'parentix', 'electron',
]);

/**
 * `Chrome.exe`, `chrome`, ` chrome.exe ` → `chrome`, or null.
 *
 * Null for anything that is not a plain executable name. The value is
 * interpolated into a PowerShell script, so this is the boundary that has to
 * hold: no quotes, no spaces, no separators, nothing that could end the string
 * literal it lands in.
 */
export function processBaseName(appId) {
  const trimmed = String(appId || '').trim().toLowerCase().replace(/\.exe$/, '');
  if (!/^[a-z0-9._+-]{1,64}$/.test(trimmed)) return null;
  if (PROTECTED.has(trimmed)) return null;
  return trimmed;
}

export const apps = {
  supported: true,

  /**
   * Close every process running under this executable name.
   *
   * @returns the number that actually went away, so the caller can tell "closed
   *          it" from "tried and could not" — a process running as another user,
   *          or elevated when the agent is not, refuses both the request and the
   *          kill.
   */
  async close(appId) {
    const name = processBaseName(appId);
    if (!name) {
      console.warn('[processes] refusing to close', appId);
      return 0;
    }

    const result = await psJson(`
$ErrorActionPreference = 'SilentlyContinue'
$name = '${name}'
$before = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
if ($before.Count -eq 0) { ConvertTo-Json -Compress @{ closed = 0 }; exit }

# Ask first: this is the same message the window's close button sends, so an
# application with unsaved work gets its chance to write a recovery file.
foreach ($proc in $before) { try { [void]$proc.CloseMainWindow() } catch { } }
Start-Sleep -Seconds 4

foreach ($proc in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
    try { $proc.Kill() } catch { }
}
Start-Sleep -Milliseconds 500

$after = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
ConvertTo-Json -Compress @{ closed = ($before.Count - $after.Count) }
`, { closed: 0 });

    return Number(result?.closed) || 0;
  },
};

/** Whether this process can change machine-wide settings — see dns.js. */
export async function isElevated() {
  try {
    const out = await ps(
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())'
      + '.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    );
    return out.trim().toLowerCase() === 'true';
  } catch {
    return false;
  }
}

export const __testing = { PROTECTED };

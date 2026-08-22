import { psStream } from './powershell.js';

/**
 * Which application the child is actually using, sampled.
 *
 * Windows has no equivalent of Android's `UsageStatsManager`, so screen time is
 * measured rather than read: every few seconds, ask which window is in front and
 * who owns it. Three details separate a number a parent can trust from one that
 * merely looks like one.
 *
 * **Idle time is subtracted at the source.** `GetLastInputInfo` is the whole of
 * it: no keyboard and no mouse for a minute means nobody is there, and this
 * emits `null` rather than a sample. A laptop left open on a browser must not
 * spend a child's whole daily allowance while they are at dinner.
 *
 * **Store apps are resolved past their host.** Every packaged app — Calculator,
 * Settings, Photos, a great many games — has a foreground window owned by
 * `ApplicationFrameHost.exe`, not by itself. Reporting the frame host is why an
 * agent that looks correct produces a report where the child's most-used
 * application is a Windows internal, and where a rule against a Store app can
 * never match. The real owner is the first child window belonging to a different
 * process.
 *
 * **The identifier is the executable name**, lowercased: `chrome.exe`. That is
 * what a rule is written against, and it is what `blocking/:childId/apps` shows
 * the parent once this machine has reported it — the same "known apps" list the
 * phone populates with package names, which is why no API change was needed to
 * make desktop rules choosable rather than typed.
 */

/** How often the front window is sampled. */
const SAMPLE_MS = 5_000;

/** No input for this long means nobody is at the machine. */
const IDLE_MS = 60_000;

const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class ParentixFg
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern int GetWindowThreadProcessId(IntPtr hWnd, out int pid);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr hWnd, EnumWindowsProc cb, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    public static uint IdleMs()
    {
        LASTINPUTINFO info = new LASTINPUTINFO();
        info.cbSize = (uint)Marshal.SizeOf(info);
        if (!GetLastInputInfo(ref info)) return 0;
        // Unchecked on purpose: TickCount wraps roughly every 25 days, and
        // unsigned subtraction gives the right answer across the wrap.
        return (uint)Environment.TickCount - info.dwTime;
    }

    public static int ForegroundPid()
    {
        IntPtr window = GetForegroundWindow();
        if (window == IntPtr.Zero) return 0;

        int pid = 0;
        GetWindowThreadProcessId(window, out pid);
        if (pid == 0) return 0;

        string name = "";
        try { name = System.Diagnostics.Process.GetProcessById(pid).ProcessName; } catch { }

        // A packaged app's window belongs to the frame host; the app itself owns
        // a child window inside it.
        if (string.Equals(name, "ApplicationFrameHost", StringComparison.OrdinalIgnoreCase))
        {
            int host = pid;
            int inner = 0;
            EnumChildWindows(window, delegate(IntPtr child, IntPtr unused)
            {
                int childPid = 0;
                GetWindowThreadProcessId(child, out childPid);
                if (childPid != 0 && childPid != host) { inner = childPid; return false; }
                return true;
            }, IntPtr.Zero);
            if (inner != 0) return inner;
        }

        return pid;
    }
}
"@

$labels = @{}
$idleLimit = ${IDLE_MS}

while ($true) {
    $payload = @{ appId = $null }
    $idle = [ParentixFg]::IdleMs()

    if ($idle -lt $idleLimit) {
        $procId = [ParentixFg]::ForegroundPid()
        if ($procId -gt 0) {
            $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
            if ($proc) {
                $exe = ($proc.ProcessName + '.exe').ToLower()
                if (-not $labels.ContainsKey($exe)) {
                    # The file description is the name a person would recognise —
                    # "Google Chrome" rather than "chrome". Reading it needs the
                    # executable's path, which a protected process will refuse;
                    # the process name is the fallback and is never empty.
                    $label = $null
                    try {
                        if ($proc.Path) {
                            $label = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($proc.Path).FileDescription
                        }
                    } catch { }
                    if ([string]::IsNullOrWhiteSpace($label)) { $label = $proc.ProcessName }
                    $labels[$exe] = $label
                }
                $payload = @{ appId = $exe; appName = $labels[$exe]; pid = $procId }
            }
        }
    }

    [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject $payload))
    [Console]::Out.Flush()
    Start-Sleep -Milliseconds ${SAMPLE_MS}
}
`;

export const foreground = {
  supported: true,

  /**
   * Begin sampling. `onSample` receives `{appId, appName, pid}` while somebody
   * is using the machine and `null` while nobody is.
   *
   * The watcher is restarted if it exits, because the alternative is a laptop
   * that silently stops measuring: a PowerShell process can be killed by a
   * cleanup tool, by a policy, or by a child who has found Task Manager, and
   * none of those should end monitoring for the rest of the session.
   */
  start(onSample) {
    let stopped = false;
    let stopChild = null;
    let restarts = 0;

    const launch = () => {
      if (stopped) return;
      stopChild = psStream(SCRIPT, (line) => {
        restarts = 0;
        onSample(line?.appId ? line : null);
      }, {
        onExit: () => {
          if (stopped) return;
          // Backed off so a script that cannot start at all — a machine where
          // PowerShell is blocked by policy — does not become a spawn loop.
          const delay = Math.min(60_000, 2_000 * 2 ** Math.min(restarts, 5));
          restarts += 1;
          console.warn(`[foreground] watcher exited; retrying in ${delay}ms`);
          setTimeout(launch, delay).unref?.();
        },
      });
    };

    launch();

    return () => {
      stopped = true;
      stopChild?.();
    };
  },
};

export const __testing = { SCRIPT, SAMPLE_MS, IDLE_MS };

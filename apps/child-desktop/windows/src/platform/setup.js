import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ps, psJson } from './powershell.js';
import { isElevated } from './processes.js';

/**
 * The once-per-installation work that Windows will not let an ordinary process
 * do: registering the agent to start at sign-in with the privileges it needs,
 * and locking down the folder that holds this computer's credential.
 *
 * ── Why the app does this at all, when there is an installer ─────────────────
 *
 * The installer does it too, and it is the better place — it is already elevated
 * and it runs before anything else. But an installer is one attempt at a machine
 * that may refuse, and every way it refuses is silent: a policy that forbids
 * creating tasks, an antivirus that eats `schtasks`, an install copied onto a
 * second machine, a child who found Task Scheduler. The agent asking the same
 * questions on first run — and being able to answer them — is what turns those
 * from "monitoring quietly does not work" into a sentence on a screen.
 *
 * ── The account is the trap, and it is not obvious ──────────────────────────
 *
 * A scheduled task belongs to an account. The account this work must be done for
 * is **the person at the keyboard**, which is not the same as the account this
 * process is running as. On a household where the child is a standard user and a
 * parent types their own administrator password at the UAC prompt, the elevated
 * process is *the parent* — so `%USERNAME%`, `os.userInfo()` and every other
 * obvious source name the wrong person, and a task created from them fires on
 * the parent's logon, on a computer the parent does not use.
 *
 * `Win32_ComputerSystem.UserName` is the interactively signed-in account
 * regardless of which token is asking, which is why `sessionOwner` exists and
 * why the setup refuses to continue when the two disagree — see `stepSecurity`
 * in `shared/src/services/setup.js`. Being wrong here does not look like a bug;
 * it looks like a laptop that is simply never monitored.
 *
 * ── What `/RL HIGHEST` can and cannot promise ───────────────────────────────
 *
 * A task registered at the highest run level gives the account **its own**
 * highest privileges. For the common household case — one account, which is an
 * administrator — that is a full token and website filtering works. For a child
 * who is a standard user it is still a standard token, and no scheduled task can
 * change that: filtering there would need a service running as SYSTEM, which is
 * a different product with an uninstall story attached. The agent reports that
 * state rather than showing a filter that is silently off.
 */

/**
 * The two tasks, named here and in `build/installer.nsh`, and queried by name in
 * `autostart.js`. Three files that cannot see each other have to agree on these
 * two strings; `services/api/tests/childDesktopPlatforms.test.js` is what keeps
 * them agreeing.
 */
const LOGON_TASK = 'Parentix Child Agent';
const WATCHDOG_TASK = 'Parentix Child Agent Watchdog';

/** How often the watchdog looks. Matches the installer's, and §9b of the doc. */
const WATCHDOG_MINUTES = 5;

/** A UAC prompt waits for a person, so this one cannot be measured in seconds. */
const ELEVATION_TIMEOUT_MS = 3 * 60 * 1000;

/** Everything inside a PowerShell single-quoted string, safely. */
const q = (value) => `'${String(value ?? '').replace(/'/g, "''")}'`;

/**
 * Who is using this computer, and who are we?
 *
 * Returns `null` when the console user cannot be read — an RDP session, fast
 * user switching, a machine with nobody signed in. Nothing acts on `null`: not
 * knowing is not evidence, the same rule `autostart.js` follows for a scheduled
 * task it could not query.
 */
async function sessionOwner() {
  const result = await psJson(`
$ErrorActionPreference = 'SilentlyContinue'
$console = (Get-CimInstance -ClassName Win32_ComputerSystem).UserName
$current = [Security.Principal.WindowsIdentity]::GetCurrent().Name
ConvertTo-Json -Compress -InputObject @{ console = [string]$console; current = [string]$current }
`, null);

  const current = result?.current || `${os.userInfo().username}`;
  const console_ = result?.console || '';
  if (!console_) return null;
  return {
    console: console_,
    current,
    matches: console_.toLowerCase() === String(current).toLowerCase(),
  };
}

/**
 * The privileged script, built once and run either directly or behind UAC.
 *
 * One script for both routes on purpose: the elevated path is the one that
 * cannot be tried on a developer's machine without a prompt, so it must not be
 * a *different* script from the one that is exercised every time the agent
 * starts from its own scheduled task.
 *
 * `Register-ScheduledTask` rather than `schtasks.exe`, for two reasons that both
 * bite on a laptop. It takes a principal with an interactive logon type, so no
 * password is ever asked for or stored — `schtasks /RU <someone else>` prompts,
 * and a prompt inside `-NonInteractive` is a hang. And it exposes the battery
 * settings: a task created with the defaults **stops when the machine goes on
 * battery and does not start on battery at all**, which on a child's laptop is a
 * parental control that switches itself off when it is unplugged.
 */
function privilegedScript({ stateDir, exePath, user, resultPath }) {
  return `
$ErrorActionPreference = 'Stop'
$result = [ordered]@{ tasks = $false; acl = $false; problems = @() }
$exe   = ${q(exePath)}
$user  = ${q(user)}
$state = ${q(stateDir)}
$out   = ${q(resultPath)}

if (-not $exe) {
  # Nothing to register, and nothing wrong: a development build asks for the
  # folder permissions and no startup entry. The caller reads a null startup.
} elseif (-not $user) {
  $result.problems += 'Parentix could not tell which account to register the sign-in task for.'
} else {
  try {
    $action    = New-ScheduledTaskAction -Execute $exe -Argument '--parentix-autostart'
    # Interactive: the agent has a window and a tray icon, and a task that runs
    # in session 0 can show neither. Highest: the account's full token, which is
    # what Set-DnsClientServerAddress needs.
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
    $settings  = New-ScheduledTaskSettingsSet \`
      -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries \`
      -StartWhenAvailable -MultipleInstances IgnoreNew \`
      -ExecutionTimeLimit ([TimeSpan]::Zero)

    $logon = New-ScheduledTaskTrigger -AtLogOn -User $user
    Register-ScheduledTask -TaskName ${q(LOGON_TASK)} -Action $action -Trigger $logon \`
      -Principal $principal -Settings $settings -Force | Out-Null

    # The watchdog answers "start again when the child ends the process", which
    # the logon trigger does not. It needs no "only if not already running" flag
    # because the agent takes a single-instance lock and a second copy quits —
    # the check lives in the thing being started, where it cannot go stale.
    $repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) \`
      -RepetitionInterval (New-TimeSpan -Minutes ${WATCHDOG_MINUTES}) \`
      -RepetitionDuration ([TimeSpan]::FromDays(3650))
    Register-ScheduledTask -TaskName ${q(WATCHDOG_TASK)} -Action $action -Trigger $repeat \`
      -Principal $principal -Settings $settings -Force | Out-Null

    $result.tasks = $true
  } catch {
    $result.problems += "Parentix could not register itself to start at sign-in: $($_.Exception.Message)"
  }
}

# ── The credential folder ────────────────────────────────────────────────────
#
# Only 'state' — the directory holding the DPAPI-sealed device token — and not
# the whole of userData, which Electron fills with caches it manages itself.
# Well-known SIDs rather than group names: 'Administrators' is 'Administrateurs'
# on a French install, and an icacls line that names it would fail on every
# machine that is not in English.
if (Test-Path -LiteralPath $state) {
  try {
    $sid = (New-Object System.Security.Principal.NTAccount($user)).Translate(
      [System.Security.Principal.SecurityIdentifier]).Value
    & icacls $state /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*\${sid}:(OI)(CI)F" /T /C /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls exited $LASTEXITCODE" }
    $result.acl = $true
  } catch {
    $result.problems += "Parentix could not lock down its credential folder: $($_.Exception.Message)"
  }
}

$result.problems = @($result.problems)
($result | ConvertTo-Json -Compress) | Set-Content -LiteralPath $out -Encoding UTF8
`;
}

/**
 * Run a script behind a UAC prompt, without relaunching the agent itself.
 *
 * **The app is deliberately not restarted elevated.** It looks like the obvious
 * move and it is the wrong one: under over-the-shoulder elevation the relaunched
 * copy runs as the *parent*, so `app.getPath('userData')` becomes the parent's
 * profile and the credential, the rules cache and the setup record all land in
 * an account nobody uses. A short-lived elevated helper doing named work for a
 * named account has neither problem — the same shape as the launchd helper on
 * the Mac, and for the same reason.
 *
 * `-EncodedCommand` all the way down, because the outer script has to embed the
 * inner one and the inner one contains both kinds of quote.
 */
async function runElevated(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const out = await ps(`
$ErrorActionPreference = 'Stop'
$args = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',${q(encoded)})
# -Verb RunAs is what raises the prompt; a refusal throws, and that is the one
# outcome the caller has to be able to tell apart from a failure.
$proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $args -Verb RunAs -WindowStyle Hidden -PassThru -Wait
[Console]::Out.Write([string]$proc.ExitCode)
`, { timeout: ELEVATION_TIMEOUT_MS });

  if (String(out).trim() !== '0') throw new Error('The Parentix setup could not finish with administrator permission.');
}

async function readResult(resultPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(resultPath, 'utf8'));
    return {
      tasks: !!parsed?.tasks,
      acl: !!parsed?.acl,
      problems: Array.isArray(parsed?.problems) ? parsed.problems.filter(Boolean).map(String) : [],
    };
  } catch {
    return { tasks: false, acl: false, problems: ['Parentix could not read the result of its own setup.'] };
  }
}

export const setup = {
  supported: true,

  isElevated,

  elevationHint:
    'Parentix needs administrator permission once, to finish setting up this computer.',

  /** A UAC prompt is something the app can raise; the macOS helper is not. */
  canRequestElevation: true,

  sessionOwner,

  /**
   * Is the account at the keyboard a local administrator?
   *
   * The single fact that decides whether the tamper protection can hold. A
   * standard-user child cannot stop the agent, change DNS, delete the scheduled
   * tasks for long, or uninstall — all of those need the administrator the
   * installer asked for. An administrator child can do every one of them, and no
   * code running as them can stop it. So the honest thing is to find out and tell
   * the parent, which `tamper.js` does; nothing here acts on it.
   *
   * Membership is read of the *console* account, independent of whether this
   * process is elevated — an unelevated agent still needs the true answer.
   * `Get-LocalGroupMember` needs no privilege to read a local group. The
   * well-known SID `S-1-5-32-544` is the Administrators group on every locale.
   *
   * `null` for anything but a clean yes or no: a domain account (where
   * `Get-LocalGroupMember` can throw on a remote principal), a machine with
   * nobody at the console, a build without the cmdlet. Not knowing is not
   * evidence, the same rule the rest of this file follows.
   */
  async sessionIsAdministrator() {
    const owner = await sessionOwner().catch(() => null);
    if (!owner?.console) return null;
    const result = await psJson(`
$ErrorActionPreference = 'Stop'
try {
  $console = ${q(owner.console)}
  $members = @(Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction Stop | ForEach-Object { $_.Name })
  $isAdmin = [bool]($members | Where-Object { $_ -ieq $console })
  ConvertTo-Json -Compress -InputObject @{ known = $true; isAdmin = $isAdmin }
} catch {
  ConvertTo-Json -Compress -InputObject @{ known = $false }
}
`, null);
    if (!result || result.known !== true) return null;
    return !!result.isAdmin;
  },

  async applyPrivileged({ stateDir, exePath, user, elevate = false }) {
    // Written beside the folder it is about rather than to the system temp
    // directory: the elevated helper runs as a different account there, and a
    // file in *its* %TEMP% is one this process cannot read back.
    const resultPath = path.join(path.dirname(stateDir), 'setup-privileged.json');
    await fs.unlink(resultPath).catch(() => {});

    const script = privilegedScript({
      stateDir,
      // Empty means "no startup entry was asked for" — a development build. The
      // script skips the tasks and says nothing about it, and `startup` comes
      // back null below.
      exePath: exePath || '',
      user: user || `${os.userInfo().username}`,
      resultPath,
    });

    if (await isElevated()) await ps(script, { timeout: 60_000 });
    else if (elevate) await runElevated(script);
    else throw new Error(setup.elevationHint);

    const result = await readResult(resultPath);
    await fs.unlink(resultPath).catch(() => {});

    return {
      startup: exePath
        ? {
          registered: result.tasks,
          mechanism: 'scheduled-task',
          detail: result.tasks
            ? 'Parentix will start with administrator access when this computer is signed in to.'
            : undefined,
        }
        : null,
      stateDirSecured: result.acl,
      problems: result.problems,
    };
  },

  /**
   * Ask the machine, not our own memory.
   *
   * `Get-ScheduledTask` needs no elevation to read, so this answers the same on
   * an unelevated relaunch as it did on the run that created the tasks — which
   * is what lets `finalize` confirm a setup that happened behind a UAC prompt
   * minutes earlier from a process that never held the token.
   */
  async verifyPrivileged({ stateDir }) {
    const result = await psJson(`
$ErrorActionPreference = 'SilentlyContinue'
$logon    = [bool](Get-ScheduledTask -TaskName ${q(LOGON_TASK)})
$watchdog = [bool](Get-ScheduledTask -TaskName ${q(WATCHDOG_TASK)})

# Secured means the folder is there AND carries no access rule for Everyone
# (S-1-1-0) or the local Users group (S-1-5-32-545), which are the two that
# would let a sibling account on this machine read the sealed credential.
#
# A folder that does not exist is *not* secured. It is tempting to answer true —
# there is nothing there to read — but the question being asked is whether the
# place the credential goes has been locked down, and "no such place" is a setup
# that did not happen rather than one that succeeded.
$secured = $false
if (Test-Path -LiteralPath ${q(stateDir)}) {
    $secured = $true
    $acl = Get-Acl -LiteralPath ${q(stateDir)}
    foreach ($rule in $acl.Access) {
        try {
            $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
        } catch { continue }
        if ($sid -eq 'S-1-1-0' -or $sid -eq 'S-1-5-32-545') { $secured = $false }
    }
}
ConvertTo-Json -Compress -InputObject @{ logon = $logon; watchdog = $watchdog; secured = $secured }
`, null);

    if (!result) {
      // Could not ask. Reported as "not registered" rather than guessed either
      // way — `finalize` accepts a login item instead, and a setup that cannot
      // confirm anything should not be recorded as complete.
      return { startup: null, stateDirSecured: false, problems: ['Parentix could not read this computer’s settings.'] };
    }

    return {
      startup: {
        registered: !!result.logon,
        mechanism: 'scheduled-task',
        detail: result.watchdog ? undefined : 'The Parentix watchdog task is missing.',
      },
      stateDirSecured: !!result.secured,
      problems: result.watchdog ? [] : ['The Parentix watchdog task is not registered on this computer.'],
    };
  },
};

export const __testing = { LOGON_TASK, WATCHDOG_TASK, privilegedScript, sessionOwner };

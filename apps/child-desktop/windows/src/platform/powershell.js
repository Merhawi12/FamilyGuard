import { spawn } from 'node:child_process';

/**
 * Running PowerShell from the agent.
 *
 * Everything Windows-specific here goes through `powershell.exe` rather than a
 * native addon, and that is a decision worth stating because the alternative
 * looks cheaper than it is. A native module would mean node-gyp, a toolchain on
 * every build machine, `electron-rebuild` against each Electron version, and a
 * separate binary per architecture — for four things (the foreground window, the
 * idle timer, the DNS servers, and whether we are elevated) that Windows already
 * exposes to a script. `powershell.exe` 5.1 is present on every supported
 * Windows install and needs nothing shipped alongside it.
 *
 * **Scripts are passed as `-EncodedCommand`, never as a file.** electron-builder
 * packs the app into `app.asar`, which is an archive: a `.ps1` inside it has a
 * path that looks real and that PowerShell cannot open. Base64 also removes
 * every quoting question, which matters because some of these scripts contain
 * both kinds of quote and a `$`.
 */

const encode = (script) => Buffer.from(script, 'utf16le').toString('base64');

const BASE_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

/**
 * Run a script and return its stdout.
 *
 * Rejects on a non-zero exit or a timeout. Callers treat both the same way —
 * a capability that cannot be read is reported as unavailable, not as a crash.
 */
export function ps(script, { timeout = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [...BASE_ARGS, '-EncodedCommand', encode(script)], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`PowerShell timed out after ${timeout}ms`));
    }, timeout);
    timer.unref?.();

    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(out);
      reject(new Error(err.trim() || `PowerShell exited ${code}`));
    });
  });
}

/** The same, parsed. `ConvertTo-Json` is the only shape these scripts return. */
export async function psJson(script, fallback = null) {
  try {
    const text = (await ps(script)).trim();
    if (!text) return fallback;
    const value = JSON.parse(text);
    // A single object comes back as an object and a list as an array; callers
    // that want a list should not have to care which.
    return value;
  } catch (error) {
    console.warn('[powershell]', error.message);
    return fallback;
  }
}

/**
 * A long-lived script that prints one JSON object per line.
 *
 * Used for the foreground-window watcher, which has to run for the life of the
 * agent. Spawning a shell every few seconds would be visible in Task Manager as
 * a process storm and would cost more than the thing it is measuring.
 *
 * Returns a `stop()`. The child is killed rather than asked to stop: it is a
 * loop with no input, and there is nothing for it to clean up.
 */
export function psStream(script, onLine, { onExit } = {}) {
  const child = spawn('powershell.exe', [...BASE_ARGS, '-EncodedCommand', encode(script)], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        try {
          onLine(JSON.parse(line));
        } catch {
          // A partial or malformed line is dropped. The next tick is a second
          // away and carries the same information.
        }
      }
      index = buffer.indexOf('\n');
    }
  });

  child.stderr.on('data', (chunk) => console.warn('[powershell:stream]', String(chunk).trim()));
  child.on('exit', (code) => onExit?.(code));

  return () => { try { child.kill(); } catch { /* already gone */ } };
}

import { spawn } from 'node:child_process';

/**
 * Running command-line tools from the agent.
 *
 * macOS ships every capability this agent needs as a command-line tool that a
 * process can call without an entitlement: `lsappinfo` for the frontmost
 * application, `ioreg` for the idle timer, `networksetup` for the resolver,
 * `kill` for closing an app. Reaching for those rather than for a native module
 * is the same trade the Windows side makes with PowerShell — no node-gyp, no
 * `electron-rebuild` against each Electron version, no per-architecture binary.
 *
 * **The tools are called with an argument array, never through a shell**, so a
 * bundle identifier out of a parent's rule cannot become a command. The one
 * exception is the sampling loop, which genuinely needs `sh` to loop — and it
 * takes no input at all.
 */

export function run(command, args = [], { timeout = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out after ${timeout}ms`));
    }, timeout);
    timer.unref?.();

    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(out);
      reject(new Error(err.trim() || `${command} exited ${code}`));
    });
  });
}

/** The same, but a failure is an empty answer rather than a rejection. */
export async function tryRun(command, args = []) {
  try {
    return await run(command, args);
  } catch (error) {
    console.warn(`[shell] ${command}:`, error.message);
    return '';
  }
}

/**
 * A long-lived `sh` loop that prints one tab-separated record per line.
 *
 * Tab-separated rather than JSON because the fields are an application's display
 * name and bundle identifier, and quoting those correctly inside a shell script
 * that is itself inside a JavaScript template literal is three levels of
 * escaping to get wrong. A tab cannot appear in either field.
 *
 * Returns a `stop()`.
 */
export function stream(script, onRecord, { onExit } = {}) {
  const child = spawn('/bin/sh', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });

  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line) onRecord(line.split('\t'));
      index = buffer.indexOf('\n');
    }
  });

  child.stderr.on('data', (chunk) => console.warn('[shell:stream]', String(chunk).trim()));
  child.on('exit', (code) => onExit?.(code));

  return () => { try { child.kill(); } catch { /* already gone */ } };
}

#!/usr/bin/env node
/**
 * Checks that the hostnames the deployment depends on resolve, and that
 * whatever answers on each one is the thing that is supposed to.
 *
 *   npm run check:dns
 *   ENV_NAME=dev npm run check:dns
 *
 * Worth having at all because a missing record has no local symptom. The API
 * keeps answering, the bundle keeps shipping, every log stays clean, and the
 * only outward sign is a browser saying "Could not reach the Parentix service"
 * — which reads as the parent's connection being at fault rather than ours. DNS
 * for the domain is edited by hand at the registrar (`manage_dns = false`), so
 * no apply, no plan and no test covers it, and there is no state to drift from.
 * This is the only thing that looks.
 *
 * Addresses are deliberately not what it asserts. A hostname can resolve
 * perfectly and still answer with the wrong site — that is precisely what a
 * leftover record does, and it is invisible to any check that only compares
 * addresses against a list someone has to remember to update. So every address
 * is asked to prove what it is: the web hostnames must serve HTML under a
 * certificate valid for the name asked for, and the API hostname must answer
 * its health endpoint.
 *
 * Node rather than a shell script, and no gcloud or terraform, because the
 * moment this is needed is an incident and the machine to hand is whatever
 * someone is sitting at. `dig` is absent on Windows and `bash` on the PATH there
 * is the WSL shim, so both would fail exactly where this has to work.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_NAME = process.env.ENV_NAME || 'prod';
const TFVARS = path.join(REPO, 'infrastructure', 'gcp', 'envs', `${ENV_NAME}.tfvars`);

const color = (code) => (s) => `[1;${code}m${s}[0m`;
// Someone running this mid-incident pipes it into a file or pastes it into a
// ticket as often as they read it, and escape codes in that paste are noise
// nobody can strip back out.
const paint = process.stdout.isTTY && !process.env.NO_COLOR ? color : () => (s) => s;
const blue = paint(34);
const red = paint(31);
const green = paint(32);
const yellow = paint(33);

let failed = false;
const pass = (msg) => console.log(`  ${green('ok')}   ${msg}`);
const fail = (msg) => { failed = true; console.log(`  ${red('fail')} ${msg}`); };
const die = (msg) => { console.error(`${red('error')} ${msg}`); process.exit(1); };

// The hostnames come from the same file Terraform reads, so this cannot drift
// from what was actually deployed.
let tfvars;
try {
  tfvars = readFileSync(TFVARS, 'utf8');
} catch {
  die(`No tfvars for '${ENV_NAME}' at ${TFVARS}.`);
}
const tfvar = (key) => tfvars.match(new RegExp(`^\\s*${key}\\s*=\\s*"(.*)"`, 'm'))?.[1] || '';

const domain = tfvar('domain');
if (!domain) die(`No 'domain' set in ${TFVARS}; nothing to check.`);

const apiHost = `${tfvar('api_subdomain')}.${domain}`;
const webHosts = [domain, `www.${domain}`, `${tfvar('app_subdomain')}.${domain}`, `${tfvar('admin_subdomain')}.${domain}`];

/**
 * Resolved over DNS-over-HTTPS rather than through the system resolver: right
 * after an edit the local cache is the least trustworthy answer available, and
 * the whole point of running this is to find out whether the change is live.
 *
 * IPv4 only. Every check below pins one address at a time, and a wrong A record
 * is what breaks — a correct AAAA cannot rescue a browser that picked the bad A.
 */
const resolveA = async (name) => {
  try {
    const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(name)}&type=A`, {
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json();
    return (body.Answer || []).filter((a) => a.type === 1).map((a) => a.data); // 1 = A; CNAMEs in the chain are ignored
  } catch {
    return [];
  }
};

/**
 * Asks one specific address to serve one specific hostname — the equivalent of
 * `curl --resolve`. A host with several A records is then judged per address
 * rather than on whichever one the resolver happened to hand back.
 *
 * `servername` sets SNI *and* is what the certificate is verified against, so an
 * address whose certificate does not cover the name fails here, exactly as it
 * would in a browser.
 */
const request = (host, addr, reqPath, extraHeaders = {}) => new Promise((resolve) => {
  const req = https.request(
    {
      host: addr, servername: host, port: 443, path: reqPath, method: 'GET',
      headers: { Host: host, ...extraHeaders }, timeout: 20_000,
    },
    (res) => { res.resume(); resolve({ status: res.statusCode, headers: res.headers }); },
  );
  req.on('timeout', () => req.destroy(new Error('timed out')));
  req.on('error', (err) => resolve({ error: err.message }));
  req.end();
});

const serves = (host, addr, reqPath) => request(host, addr, reqPath);

/**
 * Deliberately goes to the address this script resolved, not to the hostname.
 *
 * A plain fetch would hand the name to the system resolver, which is the one
 * participant here with no reason to be up to date: a name that answered
 * NXDOMAIN a minute ago stays cached as NXDOMAIN locally for the negative TTL,
 * long after the record is live in public DNS. Checking a freshly added record
 * is precisely when this script runs, so routing the CORS probe through that
 * cache would report "the API rejects your origin" for every origin whenever
 * the real answer is "your laptop has not caught up" — the exact species of
 * misleading failure this whole script exists to prevent.
 */
const allowedOrigin = async (origin, addr) => {
  const { headers, error } = await request(apiHost, addr, '/api/health', { Origin: origin });
  return error ? null : headers['access-control-allow-origin'];
};

console.log(blue('==>'), `Checking DNS for ${domain} (${ENV_NAME})`);

// ── The API hostname ────────────────────────────────────────────────────────
//
// First because it is the one with no fallback. The web apps keep their
// permanent *.web.app addresses; every client of the API — browsers and every
// installed child app alike — has this name compiled in and nothing else.
console.log(apiHost);
const apiAddrs = await resolveA(apiHost);
if (apiAddrs.length === 0) {
  fail(`does not resolve. Every sign-in and every child check-in fails while this is true.
       Add an A record for '${tfvar('api_subdomain')}' pointing at the load balancer:
         terraform -chdir=infrastructure/gcp output -raw load_balancer_ip`);
} else {
  for (const addr of apiAddrs) {
    const { status, error } = await serves(apiHost, addr, '/api/health');
    if (status === 200) pass(`${addr} answers /api/health`);
    else fail(`${addr} answered ${error || `HTTP ${status}`} for /api/health, not 200.`);
  }
}

// ── The web hostnames ───────────────────────────────────────────────────────
for (const host of webHosts) {
  console.log(host);
  const addrs = await resolveA(host);
  if (addrs.length === 0) {
    fail('does not resolve. Connect it in the Firebase console — Hosting → Add custom domain — which mints its records.');
    continue;
  }
  for (const addr of addrs) {
    const { status, error } = await serves(host, addr, '/');
    if (status === 200) {
      pass(`${addr} serves the site`);
    } else {
      // The likeliest cause by far, and the one with no other symptom: an
      // address left behind by a previous occupant of the name. A browser picks
      // between a host's addresses at random, so this is an intermittent
      // certificate warning for a share of visitors rather than a clean
      // outage, and it will not reproduce for whoever reports it.
      fail(`${addr} answered ${error || `HTTP ${status}`}, not 200.
       If ${host} has more than one A record this is the wrong one — delete it, keeping only what Firebase minted.`);
    }
  }
}

// ── CORS ────────────────────────────────────────────────────────────────────
//
// Not DNS, but indistinguishable from it to a parent: a rejected origin means
// the browser discards the response and the app reports the API as unreachable,
// while the API logs nothing, because the response it sent was fine.
console.log('CORS');
if (apiAddrs.length === 0) {
  // Asking an unresolvable name what it accepts would report a failure per
  // origin for a single cause, and bury the one record that has to be added.
  console.log(`  ${yellow('warn')} skipped — ${apiHost} does not resolve yet. Re-run once it does.`);
} else {
  for (const host of webHosts) {
    const origin = `https://${host}`;
    const allowed = await allowedOrigin(origin, apiAddrs[0]);
    if (allowed === origin) pass(`API accepts ${origin}`);
    else fail(`API does not accept ${origin}. Add it to extra_cors_origins and apply.`);
  }
}

console.log();
if (failed) die('Checks failed — see above.');
console.log(blue('==>'), 'All checks passed.');

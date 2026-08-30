#!/usr/bin/env node
/**
 * Read the contact-form backlog.
 *
 * `POST /api/contact` stores the message *before* it tries to email anyone, so a
 * broken relay or a spam verdict costs the notification and never the message
 * (see controllers/contactFormController.js). That guarantee had no way to be
 * collected: `ContactMessage` is created, classified against and destroyed by
 * account erasure, and read by nothing at all — no endpoint, no screen. So when
 * nobody receives a contact email, the messages are safe and unreachable at the
 * same time, which is the worst half of both.
 *
 * This is the missing half, as a script rather than a screen, because the people
 * who need it are operators with database access and the need is urgent when it
 * happens.
 *
 *   node scripts/contact-messages.mjs                     # local SQLite
 *   DATABASE_URL=postgres://… node scripts/contact-messages.mjs
 *   node scripts/contact-messages.mjs --status failed     # only undelivered
 *   node scripts/contact-messages.mjs --status spam --full
 *
 * Against Cloud SQL, start the proxy first and point DATABASE_URL at it:
 *   cloud-sql-proxy <project>:<region>:<instance> --port 5432 &
 *
 * `--full` prints whole message bodies; the default truncates so a long backlog
 * stays skimmable.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = path.join(REPO, 'services/api');
process.chdir(API);

const requireApi = createRequire(path.join(API, 'package.json'));
requireApi('dotenv').config({ path: path.join(API, '.env') });

const { ContactMessage } = requireApi(path.join(API, 'src/models'));

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : (args[i + 1] ?? true);
};
const wantStatus = flag('status');
const full = args.includes('--full');
const limit = Number(flag('limit')) || 100;

const trunc = (s, n) => (full || String(s).length <= n ? String(s) : `${String(s).slice(0, n)}…`);

/** What each status means, so the output does not need the source to read it. */
const MEANING = {
  new: 'stored, notification not recorded yet (in flight, or the process died before it finished)',
  notified: 'the operator email was delivered',
  failed: 'the operator email FAILED — nobody was told',
  spam: 'held by the spam checks; no email was ever attempted',
};

const rows = await ContactMessage.findAll({
  ...(wantStatus && wantStatus !== true ? { where: { status: wantStatus } } : {}),
  order: [['createdAt', 'DESC']],
  limit,
});

if (!rows.length) {
  console.log(wantStatus ? `No contact messages with status "${wantStatus}".` : 'No contact messages stored at all.');
  console.log('\nAn empty table means nothing was ever submitted — or submissions are being');
  console.log('refused before they are stored, which is the rate limiter (5 per 15 min per IP,');
  console.log('answered 429) or a validation error. Both are visible to the sender.');
  process.exit(0);
}

const counts = rows.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {});
console.log(`${rows.length} message(s)${wantStatus && wantStatus !== true ? ` with status "${wantStatus}"` : ''}\n`);
for (const [status, n] of Object.entries(counts)) {
  console.log(`  ${String(n).padStart(4)}  ${status.padEnd(9)} ${MEANING[status] || ''}`);
}
console.log();

for (const r of rows) {
  console.log('─'.repeat(78));
  console.log(`${r.createdAt.toISOString()}  [${r.status}]  ${r.name} <${r.email}>`);
  if (r.spamReason) console.log(`  held as spam: ${r.spamReason}`);
  if (r.deliveryError) console.log(`  delivery error: ${r.deliveryError}`);
  console.log(`  receipt to sender: ${r.receiptSent ? 'sent' : 'not sent'}   reference: ${r.id}`);
  console.log();
  console.log(trunc(r.message, 400).split('\n').map((l) => `    ${l}`).join('\n'));
  console.log();
}

process.exit(0);

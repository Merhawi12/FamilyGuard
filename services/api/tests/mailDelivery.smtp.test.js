/**
 * The mailer, against a real SMTP conversation.
 *
 * Every other suite replaces `services/mailer` with a jest mock, which proves a
 * controller called it and nothing whatsoever about whether a message can leave
 * the process. That gap is where the production failure lived: the mailer was
 * handed the host `" "` — the placeholder Terraform seeds an unsupplied secret
 * with, because Secret Manager will not store an empty version — built a
 * transport from it anyway, and every send threw into the catch that stops a
 * notification from failing the request that triggered it. Callers were told a
 * reset link had been sent. Nothing arrived, and nothing in the suite noticed.
 *
 * So this file runs a throwaway relay and reads back the bytes the mailer
 * actually wrote to it.
 *
 * The module graph is loaded through `jest.isolateModules` rather than at the
 * top of the file: `tests/db.setup.js` requires `src/config/db` → `src/config/env`
 * before any test file body executes, so by the time an assignment to
 * `process.env` here would run, config has already been read and frozen. An
 * isolated registry re-reads it. Nothing in this graph touches Sequelize, so no
 * second connection pool is created.
 */
jest.setTimeout(30000);

const net = require('node:net');

const SMTP_PORT = 5325;
const CLIENT_URL = 'https://app.parentix.ca';

const inbox = [];
let smtp;

// ── A relay that accepts anything and remembers it ───────────────────────────
const startSmtp = () =>
  new Promise((resolve, reject) => {
    smtp = net.createServer((socket) => {
      let buffer = '';
      let inData = false;
      // The envelope, which is what a relay actually routes on — the To: header
      // is decoration and can disagree with it.
      let rcpt = [];

      socket.write('220 test.local ESMTP ready\r\n');

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');

        // DATA runs until a lone dot on its own line; commands resume after it.
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          inbox.push({ rcpt, raw: buffer.slice(0, end) });
          rcpt = [];
          inData = false;
          buffer = buffer.slice(end + 5);
          socket.write('250 2.0.0 Ok: queued\r\n');
        }

        let idx;
        while (!inData && (idx = buffer.indexOf('\r\n')) !== -1) {
          const command = buffer.slice(0, idx);
          const verb = command.split(' ')[0].toUpperCase();
          buffer = buffer.slice(idx + 2);

          if (verb === 'RCPT') {
            const address = command.match(/<([^>]*)>/);
            if (address) rcpt.push(address[1]);
            socket.write('250 2.1.5 Ok\r\n');
          } else if (verb === 'EHLO' || verb === 'HELO') {
            // Advertises neither STARTTLS nor AUTH, so nodemailer stays in
            // plaintext — which is all this needs to observe.
            socket.write('250-test.local\r\n250 8BITMIME\r\n');
          } else if (verb === 'DATA') {
            inData = true;
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (verb === 'QUIT') {
            socket.write('221 2.0.0 Bye\r\n');
            socket.end();
          } else {
            socket.write('250 2.1.0 Ok\r\n');
          }
        }
      });

      socket.on('error', () => {
        /* nodemailer can close abruptly after QUIT */
      });
    });

    smtp.once('error', reject);
    smtp.listen(SMTP_PORT, '127.0.0.1', resolve);
  });

/**
 * MIME bodies are transfer-encoded, and a 64-character token inside a URL is
 * long enough for quoted-printable to split across lines — so searching the raw
 * bytes for it finds nothing. Undo the encoding before looking.
 */
const decode = (raw) => {
  const body = raw.split(/\r\n\r\n/).slice(1).join('\r\n\r\n');
  if (/Content-Transfer-Encoding:\s*base64/i.test(raw)) {
    return Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8');
  }
  return body
    .replace(/=\r\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
};

/** @returns {{ body: string, rcpt: string[] }} the decoded message and its envelope. */
const waitForMessage = async (timeoutMs = 10000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (inbox.length) {
      const received = inbox.shift();
      return { body: decode(received.raw), rcpt: received.rcpt };
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('No message reached the SMTP relay within the timeout');
};

/** Loads utils/email under the given environment, in its own module registry. */
const loadMailer = (overrides) => {
  const keys = ['EMAIL_PROVIDER', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'CLIENT_URL'];
  const saved = {};
  for (const key of keys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, overrides);

  try {
    let loaded;
    jest.isolateModules(() => {
      loaded = { email: require('../src/utils/email'), mailer: require('../src/services/mailer') };
    });
    return loaded;
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
};

const LIVE = {
  EMAIL_PROVIDER: 'smtp',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: String(SMTP_PORT),
  SMTP_SECURE: 'false',
  CLIENT_URL,
};

beforeAll(startSmtp);
afterAll(() => new Promise((resolve) => smtp.close(resolve)));
beforeEach(() => {
  inbox.length = 0;
});

describe('the password reset email actually leaves the process', () => {
  it('delivers a message carrying the reset link for the token it was given', async () => {
    const { email } = loadMailer(LIVE);
    const token = 'a1b2c3d4'.repeat(8); // 64 hex characters, as the controller mints

    const sent = await email.sendPasswordResetEmail({ name: 'Reset User', email: 'reset@example.com', token });
    expect(sent).not.toBe(false);

    const { body } = await waitForMessage();

    expect(body).toMatch(/reset your Parentix password/i);
    // The link is on the configured client origin and carries exactly the token
    // the caller passed — which is the token the controller stored on the user.
    expect(body).toContain(`${CLIENT_URL}/reset-password?token=${token}`);
  });

  it('addresses the message to the account that asked for it', async () => {
    const { email } = loadMailer(LIVE);

    await email.sendPasswordResetEmail({ name: 'Someone', email: 'recipient@example.com', token: 'f'.repeat(64) });
    const { rcpt } = await waitForMessage();

    // Checked against the SMTP envelope rather than the To: header — the
    // envelope is what a relay routes on, so a misrouted message fails here
    // rather than becoming a support ticket.
    expect(rcpt).toEqual(['recipient@example.com']);
  });

  it('delivers the signup verification code as six digits', async () => {
    const { email } = loadMailer(LIVE);

    await email.sendVerificationEmail({ name: 'New User', email: 'verify@example.com', code: '048319' });
    const { body, rcpt } = await waitForMessage();

    expect(rcpt).toEqual(['verify@example.com']);
    expect(body).toContain('048319');
    expect(body).toMatch(/expires in/i);
  });

  it('escapes a name so it cannot inject markup into the message', async () => {
    const { email } = loadMailer(LIVE);

    await email.sendPasswordResetEmail({
      name: '<img src=x onerror=alert(1)>',
      email: 'xss@example.com',
      token: 'b'.repeat(64),
    });
    const { body } = await waitForMessage();

    expect(body).not.toContain('<img src=x');
    expect(body).toContain('&lt;img');
  });
});

describe('an unconfigured relay is not mistaken for a working one', () => {
  it('sends nothing and reports itself disabled when the host is the unsupplied placeholder', async () => {
    // The exact production state: EMAIL_PROVIDER=smtp from Terraform, SMTP_HOST
    // still the single space Secret Manager was seeded with.
    const { email, mailer } = loadMailer({ ...LIVE, SMTP_HOST: ' ' });

    expect(mailer.isEnabled()).toBe(false);

    const sent = await email.sendPasswordResetEmail({
      name: 'Nobody', email: 'nowhere@example.com', token: 'c'.repeat(64),
    });

    // Reports that nothing went out, rather than claiming success…
    expect(sent).toBe(false);
    // …and nothing was written to the relay.
    await new Promise((r) => setTimeout(r, 300));
    expect(inbox).toHaveLength(0);
  });

  it('reports failure rather than success when the relay refuses the connection', async () => {
    // A real host that is not listening: a wrong hostname, a firewall, an
    // expired credential. `send` must swallow it and report false.
    const { email, mailer } = loadMailer({ ...LIVE, SMTP_PORT: '5326' });

    expect(mailer.isEnabled()).toBe(true);
    expect(await email.sendPasswordResetEmail({
      name: 'Nobody', email: 'nowhere@example.com', token: 'd'.repeat(64),
    })).toBe(false);
  });
});

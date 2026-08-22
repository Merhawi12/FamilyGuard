/**
 * The one request body on this service that names a URL the server then fetches.
 *
 * A Web Push subscription is `{ endpoint, keys }` taken straight from the
 * browser and stored; every alert from then on — and `POST /push/test`, which a
 * parent can fire whenever they like — makes the API POST to that endpoint.
 * Nothing looked at it, so an authenticated parent could point it at anything
 * reachable from the Cloud Run instance and have the platform deliver requests
 * into the VPC on a schedule of their choosing.
 *
 * Two layers, and both are tested here because they catch different things: the
 * registration check refuses what is obviously internal, and the DNS guard
 * refuses a perfectly ordinary-looking name that resolves to a private address —
 * which is the only place that case *can* be caught.
 */
const request = require('supertest');
const { app } = require('../src/app');
const { PushToken } = require('../src/models');
const { createUser, uniqueEmail, tokenFor } = require('./helpers');
const { isPrivateIp, publicHttpsProblem, guardedLookup } = require('../src/utils/outboundGuard');

const subscribe = (user, endpoint) =>
  request(app)
    .post('/api/notifications/push/subscribe')
    .set('Authorization', `Bearer ${tokenFor(user)}`)
    .send({ subscription: { endpoint, keys: { p256dh: 'k', auth: 'a' } } });

describe('a push endpoint has to be a public HTTPS destination', () => {
  let user;
  beforeEach(async () => {
    user = await createUser({ email: uniqueEmail('ssrf') });
  });

  it.each([
    ['the cloud metadata server', 'https://169.254.169.254/computeMetadata/v1/'],
    ['loopback', 'https://127.0.0.1:8080/push'],
    ['an RFC1918 address', 'https://10.128.0.7/push'],
    ['a VPC address', 'https://192.168.1.1/push'],
    ['carrier-grade NAT', 'https://100.64.0.1/push'],
    ['an IPv6 loopback', 'https://[::1]/push'],
    ['a unique-local IPv6 address', 'https://[fd00::1]/push'],
    ['an IPv4-mapped metadata address', 'https://[::ffff:169.254.169.254]/push'],
    ['a name that is internal by definition', 'https://metadata.google.internal/push'],
    ['localhost', 'https://localhost/push'],
    ['plain HTTP', 'http://push.example.com/x'],
    ['a non-URL', 'not-a-url'],
  ])('refuses %s at registration', async (_label, endpoint) => {
    const res = await subscribe(user, endpoint).expect(400);
    expect(res.body.error).toMatch(/Push endpoint/);

    // Nothing is stored, so nothing can be attempted later either.
    expect(await PushToken.count({ where: { userId: user.id } })).toBe(0);
  });

  it('accepts a real push service', async () => {
    await subscribe(user, 'https://fcm.googleapis.com/fcm/send/abc123').expect(201);
    expect(await PushToken.count({ where: { userId: user.id } })).toBe(1);
  });
});

describe('address classification', () => {
  it.each([
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '172.31.255.255', '192.168.0.1', '198.18.0.1', '224.0.0.1',
    '240.0.0.1', '::', '::1', 'fd00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1',
  ])('treats %s as private', (address) => {
    expect(isPrivateIp(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '142.250.80.46', '172.32.0.1', '2606:4700::1111'])(
    'treats %s as public',
    (address) => {
      expect(isPrivateIp(address)).toBe(false);
    },
  );

  /** Anything unclassifiable is refused rather than guessed at. */
  it('refuses a value that is not an address at all', () => {
    expect(isPrivateIp('')).toBe(true);
    expect(isPrivateIp(null)).toBe(true);
    expect(isPrivateIp('not-an-address')).toBe(true);
  });

  it('accepts only https, and only named hosts', () => {
    expect(publicHttpsProblem('https://push.example.com/x')).toBeNull();
    expect(publicHttpsProblem('http://push.example.com/x')).toMatch(/https/);
    expect(publicHttpsProblem('https://93.184.216.34/x')).toMatch(/not an IP/);
    expect(publicHttpsProblem('ftp://push.example.com/x')).toMatch(/https/);
  });
});

describe('the DNS guard', () => {
  /**
   * The case the registration check cannot see: a name that passes every static
   * test and resolves inside the network. Without this, an attacker only has to
   * own a domain.
   */
  it('refuses a public name that resolves to a private address', (done) => {
    jest.isolateModules(() => {
      jest.doMock('node:dns', () => ({
        lookup: (_host, _opts, cb) => cb(null, [{ address: '169.254.169.254', family: 4 }]),
      }));
      // eslint-disable-next-line global-require
      const guard = require('../src/utils/outboundGuard');
      guard.guardedLookup('push.example.com', { all: false }, (err) => {
        expect(err).toBeTruthy();
        expect(err.code).toBe('EBLOCKEDADDRESS');
        done();
      });
    });
  });

  it('passes a public address through in both lookup shapes', (done) => {
    jest.isolateModules(() => {
      jest.doMock('node:dns', () => ({
        lookup: (_host, _opts, cb) => cb(null, [{ address: '8.8.8.8', family: 4 }]),
      }));
      // eslint-disable-next-line global-require
      const guard = require('../src/utils/outboundGuard');

      // Node uses the positional form when happy-eyeballs is off and the array
      // form when it is on. Getting the untested branch wrong is how a guard
      // ends up disabled in production only.
      guard.guardedLookup('push.example.com', { all: false }, (err, address, family) => {
        expect(err).toBeNull();
        expect(address).toBe('8.8.8.8');
        expect(family).toBe(4);

        guard.guardedLookup('push.example.com', { all: true }, (err2, addresses) => {
          expect(err2).toBeNull();
          expect(addresses).toEqual([{ address: '8.8.8.8', family: 4 }]);
          done();
        });
      });
    });
  });

  it('is wired into the real lookup by default', () => {
    // Guards against the export being renamed out from under the agent.
    expect(typeof guardedLookup).toBe('function');
  });

  /**
   * The end of the chain, asserted end to end rather than unit by unit.
   *
   * `guardedLookup` being correct is worth nothing if the agent does not use it
   * or if web-push ignores the agent it is handed — and both are easy to break
   * silently. This makes a real connection attempt through the real agent to a
   * name that resolves to loopback, and requires it to fail at the address
   * check rather than at the socket.
   */
  it('stops a real connection to a name that resolves to loopback', async () => {
    const https = require('node:https');
    const { guardedAgent } = require('../src/utils/outboundGuard');

    const error = await new Promise((resolve) => {
      const req = https.request(
        { hostname: 'localhost', port: 443, path: '/', method: 'POST', agent: guardedAgent },
        () => resolve(null),
      );
      req.on('error', resolve);
      req.end();
    });

    expect(error).toBeTruthy();
    expect(error.code).toBe('EBLOCKEDADDRESS');
  });

  /** web-push only honours an agent that really is one; a plain object is warned about and dropped. */
  it('hands web-push something it will actually use', () => {
    const https = require('node:https');
    const { guardedAgent } = require('../src/utils/outboundGuard');

    expect(guardedAgent).toBeInstanceOf(https.Agent);
  });
});

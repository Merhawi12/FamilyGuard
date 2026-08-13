/**
 * Who is allowed to *open* a socket, judged at the transport layer.
 *
 * This sits below sockets/auth.js on purpose. That middleware decides whose
 * token is good; this decides whose handshake engine.io will answer at all, and
 * a refusal here never reaches any of it — the client sees a bare HTTP 400 with
 * `{"code":3}` and no explanation it can act on.
 *
 * The gap these close is why they exist. Every socket test in this suite drives
 * socket.io-client from Node, which sends no Origin header, so all of them
 * passed against a server that refused the only client that matters. React
 * Native's Android WebSocket does not have that choice: WebSocketModule.java
 * fills in `getDefaultOrigin(url)` when the caller supplies none, so the child
 * app announces `https://api.parentix.ca` — the API's own name — and was refused
 * by an allowlist naming only the web apps. In 14 days of production, 401
 * handshakes from okhttp, none successful, while browsers upgraded normally.
 *
 * So these assert the four callers that exist, at the status-code level rather
 * than through a client that would paper over the difference.
 */
const WebSocket = require('ws');
const { httpServer, io } = require('../src/app');
const { env } = require('../src/config/env');

const ALLOWED = 'http://localhost:3000';

let port;
const opened = [];

/**
 * Attempts the upgrade and resolves the HTTP outcome: 101 when the socket opens,
 * otherwise whatever status engine.io refused with. Deliberately raw — a
 * socket.io-client would retry and reshape the failure into a `connect_error`,
 * which is the shape that hid this in the first place.
 */
const upgrade = (origin) => new Promise((resolve) => {
  const opts = { handshakeTimeout: 5000 };
  if (origin !== undefined) opts.origin = origin;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`, opts);
  opened.push(socket);

  let settled = false;
  const guard = setTimeout(() => finish(0), 6000);
  const finish = (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(guard);
    resolve(value);
  };

  // The open frame carries the session id; receiving it proves a real upgrade.
  socket.on('message', () => finish(101));
  socket.on('unexpected-response', (req, res) => finish(res.statusCode));
  socket.on('error', () => finish(0));
});

beforeAll((done) => {
  httpServer.listen(0, () => {
    port = httpServer.address().port;
    done();
  });
});

// A refused handshake leaves nothing behind, but an accepted one is a live
// engine.io connection, and httpServer.close() waits on those rather than
// cutting them — which is a worker that never exits, not a failure.
afterEach(() => {
  while (opened.length) {
    const socket = opened.pop();
    try { socket.terminate(); } catch { /* already gone */ }
  }
});

afterAll((done) => {
  io.close(done);
});

describe('Socket.IO handshake origins', () => {
  it('is configured with the origin under test', () => {
    expect(env.corsOrigins).toContain(ALLOWED);
  });

  it('accepts a caller that sends no Origin', async () => {
    // Stripe's webhook, an uptime probe, and every socket test in this suite.
    await expect(upgrade(undefined)).resolves.toBe(101);
  });

  it('accepts a configured browser origin', async () => {
    await expect(upgrade(ALLOWED)).resolves.toBe(101);
  });

  it('accepts an origin naming the host it is connecting to', async () => {
    // What React Native sends, and the case that was broken in production. The
    // client never chose this value, so refusing it refuses the device itself.
    await expect(upgrade(`http://127.0.0.1:${port}`)).resolves.toBe(101);
  });

  it('still refuses a third-party origin', async () => {
    // The half that must not be traded away for the one above. An early draft of
    // the fix answered `{ origin: false }` instead of erroring, which omits the
    // CORS headers but completes the upgrade anyway — a browser check on a
    // connection that is already open protects nothing.
    await expect(upgrade('https://evil.example.com')).resolves.toBe(400);
  });

  it('refuses a third-party origin even when the Host is spoofed to match', async () => {
    // `ws` derives Host from the URL, so this is the closest a test gets to a
    // crafted request: the origin is a real third party and the host is not it.
    await expect(upgrade('https://evil.example.com/')).resolves.toBe(400);
  });
});

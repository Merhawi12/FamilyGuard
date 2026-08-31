const request = require('supertest');
const { app } = require('../src/app');
const { createUser, tokenFor, createChild, createDevice } = require('./helpers');
const {
  ONLINE_WINDOW_MS, PRESENCE_TIMEOUT_MS, connectedDevices, isDeviceOnline, withPresence,
} = require('../src/utils/devicePresence');
const { ONLINE_WINDOW_MS: ADMIN_WINDOW } = require('../src/utils/devicePresence');

/**
 * Whether a device is connected — the one answer, and why it is the server's.
 *
 * This used to be worked out on each client from `Device.lastSeen`, with a
 * window each picked for itself: five minutes on the parent's device card,
 * fifteen in the console's fleet view. Neither matched what the agents do. The
 * phone's heartbeat runs from a background task registered with
 * `minimumInterval: 15 * 60` — a *floor*, which Doze raises — so a phone that
 * was switched on, connected and working correctly was reported offline to its
 * parent for most of every cycle, while support saw the same phone as online.
 *
 * The checks below pin the three properties that were missing rather than the
 * arithmetic:
 *
 *   1. the answer is on the response, so no client re-derives it;
 *   2. a live socket counts as present even when the timestamp has aged out;
 *   3. a presence lookup that *fails* falls back to the timestamp rather than
 *      reporting the whole fleet offline — a broken lookup must not become bad
 *      news about somebody's child.
 */

const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000);

describe('One definition of online', () => {
  it('is the same window on the parent screens and in the console', () => {
    // Imported twice above from the one module on purpose: the console used to
    // carry its own fifteen minutes and the family app its own five, and this is
    // the assertion that stops a second constant being introduced quietly.
    expect(ADMIN_WINDOW).toBe(ONLINE_WINDOW_MS);
    expect(ONLINE_WINDOW_MS).toBe(15 * 60 * 1000);
  });

  it('does not call a device that has never reported online', () => {
    expect(isDeviceOnline({ id: 'd1', lastSeen: null }, null)).toBe(false);
  });

  it('reads a recent check-in as online', () => {
    expect(isDeviceOnline({ id: 'd1', lastSeen: minutesAgo(4) }, null)).toBe(true);
  });

  /**
   * The case the old five-minute window got wrong on every phone in the fleet.
   */
  it('still reads a phone that checked in eight minutes ago as online', () => {
    expect(isDeviceOnline({ id: 'd1', lastSeen: minutesAgo(8) }, null)).toBe(true);
  });

  it('reads a device silent for an hour as offline', () => {
    expect(isDeviceOnline({ id: 'd1', lastSeen: minutesAgo(60) }, null)).toBe(false);
  });

  /**
   * The socket is a second positive signal, never a veto.
   *
   * A device connected right now is online however old its last REST check-in
   * is; a device with no socket but a fresh check-in is online too. Making
   * either able to overrule the other is what would let this report a present
   * child as missing.
   */
  it('counts a live socket as present even when the timestamp has aged out', () => {
    const connected = new Set(['d1']);
    expect(isDeviceOnline({ id: 'd1', lastSeen: minutesAgo(300) }, connected)).toBe(true);
  });

  it('still trusts a fresh check-in from a device with no socket', () => {
    const connected = new Set(['someone-else']);
    expect(isDeviceOnline({ id: 'd1', lastSeen: minutesAgo(2) }, connected)).toBe(true);
  });
});

describe('When presence cannot be looked up', () => {
  it('reports no socket information rather than an empty fleet', async () => {
    // No `io` at all — the shape a request takes before the socket server is
    // attached, and the shape every call takes in a unit test.
    expect(await connectedDevices(null, ['d1'])).toBeNull();
    expect(await connectedDevices({}, [])).toBeNull();
  });

  it('survives an adapter that throws, and falls back to the timestamp', async () => {
    const io = { in: () => ({ fetchSockets: () => Promise.reject(new Error('redis is gone')) }) };
    // Null, not an empty set: an empty set would say "nothing is connected" and
    // turn a broken Redis into a dashboard full of offline phones.
    expect(await connectedDevices(io, ['d1'])).toBeNull();
  });

  /**
   * `GET /children` is on the critical path of nearly every screen, and with the
   * Redis adapter attached `fetchSockets()` waits on every instance of the
   * service — five seconds by default. One unresponsive instance must not turn
   * every page load in the product into a five-second wait for a status dot.
   */
  it('gives up on a lookup that hangs, rather than holding the request', async () => {
    const io = { in: () => ({ fetchSockets: () => new Promise(() => {}) }) };

    const started = Date.now();
    expect(await connectedDevices(io, ['d1'])).toBeNull();
    expect(Date.now() - started).toBeLessThan(PRESENCE_TIMEOUT_MS + 500);
  });

  it('reads the device ids off the sockets, not out of the room names', async () => {
    const io = {
      in: () => ({
        fetchSockets: async () => [
          { data: { deviceId: 'd1', role: 'child' } },
          { data: {} },
        ],
      }),
    };
    const connected = await connectedDevices(io, ['d1', 'd2']);
    expect([...connected]).toEqual(['d1']);
  });
});

describe('withPresence', () => {
  it('serialises the row and stamps the answer onto it', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id, { lastSeen: minutesAgo(2) });

    const [row] = await withPresence(null, [device]);
    expect(row.id).toBe(device.id);
    expect(row.online).toBe(true);
    // Proof it went through `toJSON()`: a field assigned to a Sequelize instance
    // never reaches `res.json`.
    expect(Object.prototype.hasOwnProperty.call(row, 'online')).toBe(true);
  });
});

describe('The parent-facing lists carry it', () => {
  const family = async (deviceOverrides = {}) => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id, deviceOverrides);
    return { parent, child, device, auth: `Bearer ${tokenFor(parent)}` };
  };

  it('GET /devices reports online on each device', async () => {
    const f = await family({ lastSeen: minutesAgo(3) });

    const res = await request(app).get('/api/devices').set('Authorization', f.auth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].online).toBe(true);
  });

  it('GET /children reports it on the nested devices, which is where the cards read it', async () => {
    const f = await family({ lastSeen: minutesAgo(3) });

    const res = await request(app).get('/api/children').set('Authorization', f.auth);
    expect(res.status).toBe(200);
    expect(res.body[0].devices).toHaveLength(1);
    expect(res.body[0].devices[0].online).toBe(true);
    // The rest of the child still has to survive the reshaping.
    expect(res.body[0].name).toBe('Kid');
    expect(res.body[0].id).toBe(f.child.id);
  });

  it('a child with no devices is still listed', async () => {
    const parent = await createUser();
    await createChild(parent.id);

    const res = await request(app).get('/api/children').set('Authorization', `Bearer ${tokenFor(parent)}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].devices).toEqual([]);
  });

  it('says offline for a device that has been silent for hours', async () => {
    const f = await family({ lastSeen: minutesAgo(240) });

    const res = await request(app).get('/api/devices').set('Authorization', f.auth);
    expect(res.body[0].online).toBe(false);
  });
});

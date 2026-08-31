const logger = require('./logger');

/**
 * Whether a device is connected right now — one answer, for every screen that
 * asks it.
 *
 * ## Why a timestamp alone was the wrong question
 *
 * Presence used to be derived entirely from `Device.lastSeen`, and each screen
 * picked its own window: the parent's device card said online inside **five**
 * minutes, the console's fleet view inside **fifteen**. So the same phone read
 * as connected to support and disconnected to the parent, at the same instant,
 * and neither number was chosen against what the agents actually do.
 *
 * What they actually do is check in far less often than the tighter of those
 * windows. The phone's `deviceApi.heartbeat()` runs from an Expo background task
 * registered with `minimumInterval: 15 * 60` — "no more often than every fifteen
 * minutes", which Android's Doze stretches further, and which iOS treats as a
 * hint it is free to ignore for hours. A foreground timer cannot close the gap
 * either: the child app is an agent, so it is almost never the foreground app,
 * and React Native suspends its timers when it is not.
 *
 * The result was that a phone which was switched on, connected and working
 * correctly showed as offline on its parent's dashboard for roughly two thirds
 * of every check-in cycle. In a product whose whole promise is "you can see that
 * their phone is with them", the single most reassuring signal on the screen was
 * usually wrong, and wrong in the alarming direction.
 *
 * ## The socket already knows
 *
 * A running agent holds a Socket.IO connection and sits in `device:<id>` for as
 * long as its process is alive — that is how a block reaches it in a second.
 * Socket.IO's own ping/pong drops the connection when the phone goes away, so
 * membership of that room is an accurate, continuously maintained answer to
 * exactly the question these screens are asking, and it costs nothing to keep.
 *
 * `fetchSockets()` is cluster-wide when the Redis adapter is attached (see
 * realtime/adapter.js), so this stays correct across Cloud Run instances rather
 * than reporting only the devices that happen to have landed on the instance
 * serving the request.
 *
 * ## The timestamp stays, as the second of two positive signals
 *
 * `lastSeen` is not replaced, because a live socket is not the only proof of
 * life: a device that uploaded web history a minute ago over plain REST is
 * plainly present even if its socket has just dropped and not yet retried. So
 * the two are OR-ed and neither can veto the other — which also makes this
 * change strictly additive. A device that read as online before still does; the
 * ones that change are the ones that were being reported offline while
 * connected.
 *
 * That direction matters for the failure path too. When the socket layer cannot
 * answer — no `io` on the request, Redis unreachable, `fetchSockets()` timing
 * out — `connectedDevices` returns `null` rather than an empty set, and every
 * caller falls back to the window below. An empty set would have said "nothing
 * is connected", turning a broken lookup into a dashboard full of offline
 * phones: a failed request rendered as bad news.
 */

/**
 * How long after its last check-in a device with no live socket is still
 * reported as online.
 *
 * Three missed check-ins from the desktop agent, which syncs every five minutes
 * (`SYNC_INTERVAL_MS` in child-desktop's agent.js), and one from a phone at its
 * best-case fifteen. Kept generous on purpose: with the socket carrying the live
 * answer this is now the *fallback* for an agent that is reporting over REST but
 * not connected, and being briefly slow to notice a phone has gone is a much
 * cheaper mistake than repeatedly claiming a present one is missing.
 */
const ONLINE_WINDOW_MS = 15 * 60 * 1000;

const deviceRoom = (deviceId) => `device:${deviceId}`;

/**
 * How long a presence lookup may take before the answer is given up on.
 *
 * With the Redis adapter attached, `fetchSockets()` is a request/response across
 * every instance of the service, and it waits for all of them — the adapter's
 * own `requestsTimeout` defaults to five seconds. `GET /children` is on the
 * critical path of nearly every screen in the family app, so one unresponsive
 * instance would otherwise turn every page load in the product into a five-second
 * wait for a decoration on a status dot.
 *
 * Losing the race is not a failure: it falls back to `lastSeen` like any other
 * unavailable lookup, and the caller never learns the difference.
 */
const PRESENCE_TIMEOUT_MS = 750;

const deadline = (ms) => new Promise((resolve) => {
  // `unref` so a pending timer cannot hold the process open — this runs on every
  // list request, and the test suite exits between them.
  const timer = setTimeout(() => resolve(null), ms);
  if (typeof timer.unref === 'function') timer.unref();
});

/**
 * Which of these devices hold a live socket, or `null` if that cannot be
 * determined. Never throws — presence is a decoration on a list, and a device
 * list that fails to load is a far worse outcome than one that falls back to
 * timestamps.
 *
 * @param {import('socket.io').Server|null|undefined} io
 * @param {string[]} deviceIds
 * @returns {Promise<Set<string>|null>}
 */
const connectedDevices = async (io, deviceIds) => {
  const ids = [...new Set((deviceIds || []).filter(Boolean).map(String))];
  if (!io || ids.length === 0) return null;

  try {
    // One round trip for the whole page rather than one per row: `in()` takes
    // every room at once and the union it returns is de-duplicated for us.
    const sockets = await Promise.race([
      io.in(ids.map(deviceRoom)).fetchSockets(),
      deadline(PRESENCE_TIMEOUT_MS),
    ]);
    // The deadline won. Nothing is known, which is not the same as nothing being
    // connected — say so, and let the caller fall back to the timestamp.
    if (sockets === null) {
      logger.warn('Device presence lookup timed out — falling back to last check-in');
      return null;
    }

    const connected = new Set();
    for (const socket of sockets) {
      // Read from `socket.data`, which the handshake middleware fills and the
      // Redis adapter carries between instances, rather than parsing room names
      // back out — the id there is the one the token was checked against.
      if (socket.data?.deviceId) connected.add(String(socket.data.deviceId));
    }
    return connected;
  } catch (err) {
    logger.warn('Device presence lookup failed — falling back to last check-in', { error: err.message });
    return null;
  }
};

/**
 * @param {{ id: string, lastSeen?: Date|string|null }} device
 * @param {Set<string>|null} connected result of `connectedDevices`
 */
const isDeviceOnline = (device, connected) => {
  if (connected && connected.has(String(device.id))) return true;
  if (!device.lastSeen) return false;
  return Date.now() - new Date(device.lastSeen).getTime() < ONLINE_WINDOW_MS;
};

/**
 * Stamps `online` onto a list of device rows before they go out.
 *
 * The clients used to work this out for themselves from `lastSeen`, each with a
 * window it chose — which is how the parent's five minutes and the console's
 * fifteen came to disagree. The answer belongs on this side, because only the
 * server can see the sockets.
 *
 * `toJSON()` first: these are Sequelize instances, and a field assigned to one
 * lands somewhere `res.json` will not serialise.
 *
 * @param {import('socket.io').Server|null|undefined} io
 * @param {Array} devices Sequelize Device instances
 */
const withPresence = async (io, devices) => {
  const rows = devices || [];
  const connected = await connectedDevices(io, rows.map((d) => d.id));
  return rows.map((device) => ({
    ...device.toJSON(),
    online: isDeviceOnline(device, connected),
  }));
};

module.exports = {
  ONLINE_WINDOW_MS, PRESENCE_TIMEOUT_MS, connectedDevices, isDeviceOnline, deviceRoom, withPresence,
};

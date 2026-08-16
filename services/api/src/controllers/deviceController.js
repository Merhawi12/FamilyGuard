const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');
const { Device, Child, User, AppRule, WebsiteRule, ScreenTimeRule, ActivityLog } = require('../models');
const { generateLinkingCode } = require('../utils/crypto');
const { auditLog } = require('../utils/auditLogger');
const { buildContactSync } = require('../utils/contactSync');
const { deviceAllowance } = require('../middleware/featureGate');
const { blindIndex } = require('../utils/crypto');
const { getContentPolicy } = require('../utils/contentSettings');
const { deviceWebsiteRules } = require('../utils/contentPolicy');
const { disconnectDeviceSockets } = require('../utils/session');
const { reportRiskyBrowsing } = require('../utils/riskyBrowsing');
const { track } = require('../utils/background');
const { isUuid } = require('../utils/ids');
const { env } = require('../config/env');

const getDevices = async (req, res, next) => {
  try {
    // Removed children are excluded, not just their devices: an account that
    // removed a child before deleteChild started deactivating devices still has
    // live rows attached to it, and they are not part of the family any more.
    const children = await Child.findAll({ where: { parentId: req.user.id, isActive: true }, attributes: ['id'] });
    const childIds = children.map((c) => c.id);
    const devices = await Device.findAll({ where: { childId: childIds, isActive: true }, include: ['child'] });
    res.json(devices);
  } catch (err) {
    next(err);
  }
};

/** Device types the apps offer. Mirrors DEVICE_TYPES in the Children page. */
const DEVICE_TYPES = ['android', 'ios', 'windows', 'mac'];

const LINK_CODE_TTL_MS = 30 * 60 * 1000;

/**
 * Stamps a fresh linking code on a device.
 *
 * Shared by the first link and by re-issuing one for a device that was never
 * connected, so the two cannot drift apart on TTL.
 */
const issueLinkingCode = async (device) => {
  const code = generateLinkingCode();
  await device.update({
    linkingCode: code,
    linkingCodeExpiry: new Date(Date.now() + LINK_CODE_TTL_MS),
  });

  /**
   * No QR.
   *
   * This minted a PNG data URI on every link request and nothing could ever read
   * it: the child app has no camera dependency and no scanner screen, so the
   * square the family app drew beside the code plainly meant "point the phone at
   * this" and the phone would simply never respond. The parent had no way to
   * discover that.
   *
   * Adding a scanner is a native rebuild — `expo-camera`, a CAMERA permission on
   * a product that has deliberately kept its permission set narrow, and a screen
   * that cannot be verified without a handset. The eight characters work, they
   * are what the child app asks for, and a code a child types is one fewer
   * permission on a monitoring app. So the decision is the other way: the QR
   * goes, rather than waiting indefinitely for the half that would justify it.
   *
   * The `qrcode` dependency stays — `mfaController` uses it for the two-factor
   * setup code, which authenticator apps really do scan.
   */
  return { device, code };
};

/** Loads an active device the caller's account owns, or sends the right refusal. */
const findOwnedDevice = async (req, res) => {
  // A malformed id is "not found", not a database error — see utils/ids.js for
  // why this has to be checked before the query rather than after it.
  const device = isUuid(req.params.id)
    ? await Device.findOne({ where: { id: req.params.id, isActive: true } })
    : null;
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return null;
  }
  const child = await Child.findOne({ where: { id: device.childId, parentId: req.user.id } });
  if (!child) {
    res.status(403).json({ error: 'Forbidden' });
    return null;
  }
  return device;
};

/**
 * Counts the devices this account has linked, across every child.
 *
 * Only active rows count — a removed device is a soft delete and must not keep
 * occupying an allowance slot. Neither must a device belonging to a child who
 * has been removed, which is why the children are filtered too.
 */
const countActiveDevices = async (parentId) => {
  const children = await Child.findAll({ where: { parentId, isActive: true }, attributes: ['id'] });
  if (children.length === 0) return 0;
  return Device.count({ where: { childId: children.map((c) => c.id), isActive: true } });
};

const generateLink = async (req, res, next) => {
  try {
    const { childId, deviceName, type } = req.body;
    // `isActive` matters as much as ownership. Without it a removed child could
    // still be handed a code: the row was created, the phone confirmed it, and
    // then every call it made was refused, because `authenticateDevice` walks up
    // to the child and finds it inactive. The device was invisible in the
    // parent's list too (that query filters removed children), so there was
    // nothing to remove and nothing to explain it — and, since the allowance
    // count filters the same way, the ghost did not even occupy the slot it had
    // just spent.
    const child = isUuid(childId)
      ? await Child.findOne({ where: { id: childId, parentId: req.user.id, isActive: true } })
      : null;
    if (!child) return res.status(404).json({ error: 'Child not found' });

    // The Free plan sells one device; the limit has to bite where a device is
    // created, which is here — the row exists from the moment a code is issued,
    // not when the phone confirms.
    const allowance = deviceAllowance(req.user);
    if (allowance !== null) {
      const used = await countActiveDevices(req.user.id);
      if (used >= allowance) {
        return res.status(403).json({
          error: allowance === 1
            ? 'The Free plan covers one device. Upgrade to Premium to add more.'
            : `Your plan covers ${allowance} devices. Upgrade to Premium to add more.`,
          upgradeRequired: true,
          limit: allowance,
        });
      }
    }

    const device = await Device.create({
      childId,
      name: deviceName || 'New Device',
      type: DEVICE_TYPES.includes(type) ? type : 'android',
    });

    const payload = await issueLinkingCode(device);

    auditLog(req, { userId: req.user.id, action: 'device.link_generated', entity: 'Device', entityId: device.id, metadata: { childId, deviceName } });

    res.json(payload);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/devices/:id/link — a fresh code for a device that never connected.
 *
 * Codes last 30 minutes, and the one from the original sheet is gone the moment
 * it is closed. Without this the only way to finish linking a pending device is
 * to delete it and start again, which is why unconnected rows pile up.
 *
 * Deliberately refuses a device that is already linked: re-issuing there would
 * hand out a second credential for a phone that is already reporting.
 */
const regenerateLink = async (req, res, next) => {
  try {
    const device = await findOwnedDevice(req, res);
    if (!device) return undefined;

    if (device.isLinked) {
      return res.status(400).json({ error: 'That device is already connected. Remove it to link it again.' });
    }

    const payload = await issueLinkingCode(device);
    auditLog(req, { userId: req.user.id, action: 'device.link_regenerated', entity: 'Device', entityId: device.id });
    return res.json(payload);
  } catch (err) {
    return next(err);
  }
};

/** PATCH /api/devices/:id — rename a device or correct its type. */
const updateDevice = async (req, res, next) => {
  try {
    const device = await findOwnedDevice(req, res);
    if (!device) return undefined;

    const { name, type } = req.body;
    const patch = {};

    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) return res.status(400).json({ error: 'Name cannot be empty' });
      patch.name = trimmed.slice(0, 80);
    }

    if (type !== undefined) {
      if (!DEVICE_TYPES.includes(type)) return res.status(400).json({ error: 'Unknown device type' });
      patch.type = type;
    }

    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to update' });

    await device.update(patch);
    auditLog(req, { userId: req.user.id, action: 'device.updated', entity: 'Device', entityId: device.id, metadata: patch });
    return res.json(device);
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /api/devices/confirm — the child app redeems a code.
 *
 * Unauthenticated by necessity: the phone holds no credential until this
 * answers. The code is the credential, and `deviceId` — carried in the QR
 * payload — is cross-checked against it when the client supplies one.
 *
 * Every refusal below is a link that must not be granted, and the reason each
 * one exists is that granting it produced the same silent failure: a 200, a
 * token, a phone that shows itself connected, and then a 401 on every call it
 * ever makes, with nothing on the parent's side to see or undo. `confirmLink`
 * has to answer the same question `authenticateDevice` will ask a second later
 * — is this device, its child and their parent all still active — or it hands
 * out a credential that is dead on arrival.
 */
const confirmLink = async (req, res, next) => {
  try {
    const { code, deviceId, osVersion, pushToken } = req.body;
    if (!code) return res.status(400).json({ error: 'code is required' });

    // Codes are generated as uppercase hex. The child app upper-cases what was
    // typed before sending it, but the API must not depend on a client doing
    // that: a lowercase code is the same code, and answering "invalid" to it
    // sends a family hunting for a typo that is not there.
    const normalized = String(code).trim().toUpperCase();

    const device = await Device.findOne({
      where: { linkingCode: normalized },
      include: [{
        model: Child,
        as: 'child',
        attributes: ['id', 'isActive', 'parentId'],
        include: [{ model: User, as: 'parent', attributes: ['id', 'isActive'] }],
      }],
    });

    if (!device) return res.status(404).json({ error: 'Invalid linking code' });
    if (deviceId && device.id !== deviceId) return res.status(400).json({ error: 'Invalid linking code' });
    if (!device.linkingCodeExpiry || new Date() > device.linkingCodeExpiry) {
      return res.status(400).json({ error: 'Code expired' });
    }
    if (device.isLinked) return res.status(400).json({ error: 'Device already linked' });

    // Removing a device is a soft delete that leaves the row — and its unexpired
    // code — in place. Removing a child deactivates its devices the same way. In
    // both cases the code kept working and the phone linked itself to something
    // the parent had already deleted.
    if (!device.isActive || !device.child?.isActive) {
      return res.status(410).json({
        error: 'That device was removed from the parent account. Ask them to add it again.',
      });
    }

    // A blocked or closed parent account: the code is real and the link would be
    // real, but nothing the phone reported could ever be read.
    if (!device.child.parent?.isActive) {
      return res.status(403).json({ error: 'That account is not active. Contact Parentix support.' });
    }

    /**
     * Claim the device, or lose the race.
     *
     * The checks above read the row and this writes it, and between the two the
     * same code can be presented again — a child tapping "Link this phone"
     * twice on a slow connection is enough, and the API runs on more than one
     * Cloud Run instance. Read-then-write let both requests pass `isLinked ===
     * false` and both mint a 365-day token for the same device row, of which the
     * parent could only ever remove one.
     *
     * The condition is repeated inside the UPDATE so the database decides, and
     * the loser gets exactly what a second attempt should get.
     */
    const [claimed] = await Device.update(
      {
        isLinked: true,
        osVersion,
        pushToken,
        lastSeen: new Date(),
        // Single-use, and gone from the database the moment it is spent. Leaving
        // it behind kept a live-looking credential on every linked row for the
        // lifetime of the device, and left `regenerateLink`'s "the old code must
        // stop working" guarantee resting entirely on the `isLinked` flag.
        linkingCode: null,
        linkingCodeExpiry: null,
      },
      { where: { id: device.id, isLinked: false, isActive: true } },
    );
    if (!claimed) return res.status(400).json({ error: 'Device already linked' });
    await device.reload();

    const deviceToken = jwt.sign(
      { deviceId: device.id, childId: device.childId },
      env.auth.jwtSecret,
      { expiresIn: '365d' },
    );

    /**
     * Tell the parent, now.
     *
     * The link sheet in the family app shows a code and then has no way of
     * knowing it was used — the parent had to close it and hope. This is the one
     * moment the two apps genuinely meet, so it is worth a realtime event rather
     * than a reload the parent has to think to trigger.
     */
    const io = req.app.get('io');
    if (io) {
      io.to(`parent:${device.child.parentId}`).emit('device:linked', {
        deviceId: device.id,
        childId: device.childId,
        name: device.name,
        type: device.type,
        osVersion: device.osVersion || null,
        linkedAt: new Date().toISOString(),
      });
    }

    auditLog(req, {
      userId: device.child.parentId,
      action: 'device.linked',
      entity: 'Device',
      entityId: device.id,
      metadata: { childId: device.childId, osVersion: osVersion || null },
    });

    // `device.child` was loaded only to run the checks above; it is not part of
    // this endpoint's contract and carries the parent's id, which the phone has
    // no use for.
    const { child: _child, ...payload } = device.toJSON();
    res.json({ device: payload, deviceToken });
  } catch (err) {
    next(err);
  }
};

const removeDevice = async (req, res, next) => {
  try {
    const device = await findOwnedDevice(req, res);
    if (!device) return undefined;

    await device.update({ isActive: false });
    // Deactivating the row is only half of it — an already-open socket survives
    // the handshake check that would now refuse it.
    disconnectDeviceSockets(req.app.get('io'), device.id);
    auditLog(req, { userId: req.user.id, action: 'device.removed', entity: 'Device', entityId: device.id });
    return res.json({ message: 'Device removed' });
  } catch (err) {
    return next(err);
  }
};

// GET /api/devices/me/rules — device-authenticated, returns all active rules for this device's child
const getDeviceRules = async (req, res, next) => {
  try {
    const { childId } = req;
    const [appRules, childRules, screenTimeRule, child, policy] = await Promise.all([
      AppRule.findAll({ where: { childId } }),
      WebsiteRule.findAll({ where: { childId } }),
      ScreenTimeRule.findOne({ where: { childId } }),
      // The child app greets whoever is holding the phone. Their own name is
      // the one thing it needs that no rule carries, and this is the call it
      // already makes every five minutes.
      Child.findByPk(childId, { attributes: ['name'] }),
      getContentPolicy(),
    ]);

    // The device blocks DNS names, so a category — the parent's or the
    // platform's — has to arrive here already expanded into domains. It used to
    // arrive as a row with no url, which the device could do nothing with: a
    // parent switched on "adult" and the phone blocked nothing.
    res.json({
      appRules,
      websiteRules: deviceWebsiteRules({ policy, childRules }),
      screenTimeRule: screenTimeRule || null,
      childName: child?.name || null,
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/devices/me/contacts — device-authenticated, the approved contact list
// for this device's child. `childId` comes from the device token, never the
// query string, so a device can only ever read its own child's contacts.
const getDeviceContacts = async (req, res, next) => {
  try {
    res.json(await buildContactSync(req.childId));
  } catch (err) {
    next(err);
  }
};

// POST /api/devices/me/heartbeat — update lastSeen timestamp
const deviceHeartbeat = async (req, res, next) => {
  try {
    await Device.update({ lastSeen: new Date() }, { where: { id: req.deviceId } });
    res.json({ ok: true, ts: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
};

/**
 * The usage day a reported `startTime` belongs to, as a half-open interval.
 *
 * Which day a batch of app usage counts towards is the phone's question, not the
 * server's: `UsageStatsModule` measures `totalTimeInForeground` from the
 * *device's* local midnight, and the device is the only party that knows when
 * that was. So the bucket is derived from the instant the device reported rather
 * than from this process's clock — which, on Cloud Run, is UTC while the
 * families are in Canada.
 *
 * Anchoring it to `new Date()` instead is what made every evening's syncs
 * duplicate. From about 20:00 local the server's day has already rolled over, so
 * the device's reported start is "yesterday" here, the lookup for today's row
 * misses, and each fifteen-minute sync appends another row carrying the whole
 * day's cumulative total. `getDailySummary` adds those up, so the screen-time
 * figure grew without bound over the exact hours it matters most.
 */
const usageDayWindow = (reported) => {
  const start = new Date(reported);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
};

// POST /api/devices/me/activity — log app usage without requiring parent auth
// App-usage stats arrive as the running cumulative total for the day, so we
// upsert a single row per (child, app, day) instead of creating a duplicate
// on every sync cycle. Discrete events (web visits, other categories) are appended.
const deviceLogActivity = async (req, res, next) => {
  try {
    const { appName, appPackage, category, startTime, endTime, durationMinutes, url } = req.body;

    if (category === 'app_usage' && appPackage) {
      // A malformed `startTime` falls back to now rather than poisoning the
      // window with an Invalid Date, which would match nothing and append for
      // ever — the failure mode this whole function exists to prevent.
      const reported = new Date(startTime ?? NaN);
      const { start: dayStart, end: dayEnd } = usageDayWindow(
        Number.isNaN(reported.getTime()) ? new Date() : reported,
      );

      const existing = await ActivityLog.findOne({
        where: {
          childId: req.childId,
          appPackage,
          category: 'app_usage',
          startTime: { [Op.gte]: dayStart, [Op.lt]: dayEnd },
        },
        order: [['startTime', 'ASC']],
      });

      if (existing) {
        // Client sends today's cumulative minutes — keep the max so a late/partial
        // sync can never shrink the recorded total.
        await existing.update({
          durationMinutes: Math.max(existing.durationMinutes || 0, durationMinutes || 0),
          endTime: endTime || new Date(),
          appName: appName || existing.appName,
          deviceId: req.deviceId,
        });
        return res.status(200).json(existing);
      }
    }

    const log = await ActivityLog.create({
      deviceId: req.deviceId,
      childId: req.childId,
      appName, appPackage, category, startTime: startTime || new Date(), endTime, durationMinutes, url,
    });
    res.status(201).json(log);
  } catch (err) {
    next(err);
  }
};

// ── Web history ───────────────────────────────────────────────────────────────

/** Longest gap between two lookups of a domain that still counts as one visit. */
const VISIT_WINDOW_MS = 30 * 60 * 1000;
/** Batch ceiling, so one request cannot ask the server to write unbounded rows. */
const MAX_VISITS_PER_BATCH = 200;

/**
 * Domains only — DNS carries no path or query string, so this is the whole of
 * what the device can observe, and the shape it is allowed to send.
 */
const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z]{2,63}$/i;

const normalizeDomain = (value) => {
  const domain = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  return DOMAIN_PATTERN.test(domain) ? domain : null;
};

const toTime = (value, fallback) => {
  const date = new Date(value ?? NaN);
  return Number.isNaN(date.getTime()) ? fallback : date;
};

// POST /api/devices/me/web-history — device-authenticated batch of resolved domains.
//
// Repeat lookups of one domain are folded onto a single row for as long as they
// keep arriving within the visit window: a page load resolves the same host many
// times, and a row per lookup would bury the history it is meant to show.
const deviceLogWebHistory = async (req, res, next) => {
  try {
    const { visits } = req.body;
    if (!Array.isArray(visits)) {
      return res.status(400).json({ error: 'visits must be an array' });
    }
    if (visits.length > MAX_VISITS_PER_BATCH) {
      return res.status(400).json({ error: `At most ${MAX_VISITS_PER_BATCH} visits per request` });
    }

    const now = Date.now();
    const windowStart = new Date(now - VISIT_WINDOW_MS);
    let created = 0;
    let merged = 0;
    let rejected = 0;
    // Collected as the batch is written so the risky-category check runs once
    // over the whole window rather than per visit — a page load resolves the
    // same host repeatedly, and one alert should speak for all of them.
    const accepted = [];

    for (const visit of visits) {
      const domain = normalizeDomain(visit?.domain);
      // A malformed entry is dropped and counted rather than failing the batch —
      // one bad name must not cost the device the rest of its window.
      if (!domain) { rejected += 1; continue; }
      accepted.push(domain);

      const firstSeen = toTime(visit.firstSeen, new Date(now));
      const lastSeen = toTime(visit.lastSeen, firstSeen);
      const count = Number.isFinite(visit.count) && visit.count > 0 ? Math.floor(visit.count) : 1;

      const urlHash = blindIndex(domain);
      const existing = await ActivityLog.findOne({
        where: { childId: req.childId, category: 'browsing', urlHash },
        order: [['startTime', 'DESC']],
      });

      const stillOpen = existing?.endTime && new Date(existing.endTime) >= windowStart;
      if (stillOpen) {
        await existing.update({
          endTime: new Date(Math.max(new Date(existing.endTime).getTime(), lastSeen.getTime())),
          visitCount: (existing.visitCount || 1) + count,
          // Sticky, the same rule the reporter applies on the device: one
          // blocked lookup in the window makes the visit a blocked attempt.
          blocked: !!existing.blocked || !!visit.blocked,
          deviceId: req.deviceId,
        });
        merged += 1;
      } else {
        await ActivityLog.create({
          deviceId: req.deviceId,
          childId: req.childId,
          category: 'browsing',
          // The dashboard's generic activity row reads appName; without this a
          // web visit would show there as "Unknown".
          appName: domain,
          url: domain,
          startTime: firstSeen,
          endTime: lastSeen,
          durationMinutes: 0,
          visitCount: count,
          blocked: !!visit.blocked,
        });
        created += 1;
      }
    }

    await Device.update({ lastSeen: new Date() }, { where: { id: req.deviceId } });

    /**
     * A site worth interrupting a parent about.
     *
     * `dangerous_content` was in the alert catalogue with nothing behind it: the
     * socket handler waited on a classification the phone cannot perform. This
     * is the version the platform can actually do — the device reports domains,
     * `contentCategories.js` already knows which are adult or gambling, and one
     * lookup of either is news whether or not the parent had thought to block it.
     * See utils/riskyBrowsing.js.
     *
     * Tracked rather than awaited: the visits are stored, the device is waiting
     * to clear its queue, and an alert that is slow to raise must not turn a
     * successful upload into a timeout the device will retry.
     */
    track(reportRiskyBrowsing(
      req.app.get('io'),
      { parentId: req.parentId, childId: req.childId, deviceId: req.deviceId },
      accepted,
    ));

    // The device needs to know the batch landed before it clears its queue, and
    // the counts are what make a silent partial failure visible in the logs.
    res.status(201).json({ created, merged, rejected, received: visits.length });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getDevices, generateLink, regenerateLink, confirmLink, updateDevice, removeDevice,
  getDeviceRules, getDeviceContacts, deviceHeartbeat, deviceLogActivity, deviceLogWebHistory,
};

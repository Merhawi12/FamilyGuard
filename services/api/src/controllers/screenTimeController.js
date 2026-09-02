const { Op } = require('sequelize');
const { ScreenTimeRule, ScreenTimeGrant, Child, Device } = require('../models');
const { resolveScreenTimeGrants } = require('../utils/deviceScope');
const { auditLog } = require('../utils/auditLogger');
const { isUuid } = require('../utils/ids');

// A malformed id is "not found", not a database error — see utils/ids.js for why
// this has to be checked before the query rather than after it.
const resolveChild = (childId, parentId) =>
  (isUuid(childId) ? Child.findOne({ where: { id: childId, parentId } }) : null);

/**
 * The shapes the device can actually act on.
 *
 * The phone parses a bedtime with `/^(\d{1,2}):(\d{2})$/` and treats anything
 * else as "no window" (see `parseTimeOfDay` in the child app's schedule.js), so
 * a rule saved as "9pm" is accepted, listed back to the parent as though it were
 * set, and enforces nothing at all — the failure mode this codebase refuses
 * everywhere else. A bad value is now a 400 rather than a rule that lies.
 *
 * The web form only ever produces `<input type="time">` output, so nothing here
 * fires for it; this is about the API being a surface in its own right, and
 * about the next client.
 */
const TIME_OF_DAY = /^([01]?\d|2[0-3]):[0-5]\d$/;
const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const validate = (body) => {
  if (body.dailyLimitMinutes !== undefined) {
    const minutes = body.dailyLimitMinutes;
    // 0 is "no limit" — `lockState` reads it as falsy and the child app says so.
    // A negative one would lock the phone permanently and could never be met.
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 24 * 60) {
      return 'dailyLimitMinutes must be a whole number of minutes between 0 and 1440';
    }
  }

  for (const key of ['bedtimeStart', 'bedtimeEnd']) {
    if (body[key] !== undefined && body[key] !== null && !TIME_OF_DAY.test(String(body[key]))) {
      return `${key} must be a 24-hour time, for example 21:00`;
    }
  }

  if (body.schedule !== undefined && body.schedule !== null) {
    if (typeof body.schedule !== 'object' || Array.isArray(body.schedule)) {
      return 'schedule must be an object keyed by day name';
    }
    for (const [day, window] of Object.entries(body.schedule)) {
      if (!DAY_KEYS.includes(day)) return `schedule has an unknown day: ${day}`;
      if (window === null || window === undefined) continue;
      if (typeof window !== 'object') return `schedule.${day} must be an object`;
      // Only a day that is switched on has to name hours — an off day carries no
      // restriction, and the form leaves its times at whatever they last were.
      if (!window.enabled) continue;
      for (const bound of ['start', 'end']) {
        if (!TIME_OF_DAY.test(String(window[bound]))) {
          return `schedule.${day}.${bound} must be a 24-hour time, for example 08:00`;
        }
      }
    }
  }

  return null;
};

/**
 * Which rule the caller is asking about: the child's, or one device's.
 *
 * `deviceId` is optional and its absence means the child-wide rule, which is
 * what this endpoint has always returned. Accepted from the query string or the
 * body so a GET and a PUT can name a scope the same way.
 *
 * Ownership is checked against the child rather than trusted, for the reason
 * given in blockingController.resolveDeviceScope: the id comes from the client.
 */
const resolveScope = async (childId, raw) => {
  if (raw === undefined || raw === null || raw === '') return { deviceId: null };
  if (!isUuid(raw)) return { error: 'Unknown device' };
  const device = await Device.findOne({ where: { id: raw, childId, isActive: true } });
  if (!device) return { error: 'Unknown device' };
  return { deviceId: device.id };
};

/**
 * Find the rule for a scope, creating it if this is the first time the parent
 * has looked at it.
 *
 * A device rule is born as a **copy of the child's**, not as the model's
 * defaults. Defaults would hand the parent a 120-minute limit and every day
 * switched off the moment they opened one device's settings — silently widening
 * that device past the limit the child is supposed to have, which is the exact
 * opposite of what someone narrowing a rule is trying to do. Copying means the
 * device starts by saying what the child already says, and every field that then
 * differs is one the parent deliberately changed.
 */
const findOrCreateRule = async (childId, deviceId) => {
  const existing = await ScreenTimeRule.findOne({ where: { childId, deviceId } });
  if (existing) return existing;

  if (!deviceId) return ScreenTimeRule.create({ childId, deviceId: null });

  const childWide = await ScreenTimeRule.findOne({ where: { childId, deviceId: null } });
  return ScreenTimeRule.create({
    childId,
    deviceId,
    ...(childWide ? {
      dailyLimitMinutes: childWide.dailyLimitMinutes,
      schedule: childWide.schedule,
      bedtimeEnabled: childWide.bedtimeEnabled,
      bedtimeStart: childWide.bedtimeStart,
      bedtimeEnd: childWide.bedtimeEnd,
      isActive: childWide.isActive,
    } : {}),
  });
};

/**
 * The rule a scope is currently governed by.
 *
 * Reading a device's scope must not *create* an exception for it, and that is a
 * sharper trap than it looks: the child-wide branch has always created on first
 * read (opening the page is how a child's rule comes into existence), so the
 * obvious generalisation would mint an exception for every device the dashboard
 * merely looked at — and the Screen Time page looks at all of them at once, to
 * mark which tabs carry an override. Every device would have been overridden by
 * the act of opening the screen, and the child-wide limit would then have
 * stopped reaching any of them.
 *
 * So a device scope with no exception answers with the child's rule, which is
 * the rule that device is really obeying. The caller can tell the two apart
 * without another request: `deviceId` on the response is the device's own id
 * when this is an exception, and null when it is the shared rule. The exception
 * is created on write instead — see `updateRule`.
 */
const getRule = async (req, res) => {
  const child = await resolveChild(req.params.childId, req.user.id);
  if (!child) return res.status(404).json({ error: 'Child not found' });

  const scope = await resolveScope(child.id, req.query.deviceId);
  if (scope.error) return res.status(400).json({ error: scope.error });

  if (scope.deviceId) {
    const own = await ScreenTimeRule.findOne({ where: { childId: child.id, deviceId: scope.deviceId } });
    if (own) return res.json(own);
  }

  return res.json(await findOrCreateRule(child.id, null));
};

/**
 * Push a rule to the devices it actually governs — and to nothing else.
 *
 * A child device joins `child:<childId>` *and* `device:<its own id>` when it
 * authenticates (see sockets/deviceEvents.js), so "the child's room" contains
 * every device including the ones the parent has given an exception to. This
 * used to emit a child-wide edit straight into that room on the reasoning that a
 * device with its own rule "is not listening for the child-wide one". It is: it
 * is in the room, and `rules.js` on both agents assigns the payload onto
 * `screenTimeRule` without looking at whose scope it names — it cannot look,
 * because clearing an exception delivers a child-wide rule to that same device
 * legitimately, and the two payloads are identical in shape.
 *
 * So the laptop a parent had just given three hours adopted the child's one hour
 * the next time they edited the shared rule, wrote it to its cache, and enforced
 * it until the five-minute poll replaced it. Self-healing, invisible, and wrong
 * in the direction that locks a child out of the device they were told they
 * could use.
 *
 * The rooms already hold the answer: the child's room, minus the devices that
 * are not governed by the child's rule.
 */
const announceRule = async (io, childId, deviceId, rule) => {
  if (!io) return;

  if (deviceId) {
    io.to(`device:${deviceId}`).emit('screen_time_updated', rule);
    return;
  }

  const overrides = await ScreenTimeRule.findAll({
    where: { childId, deviceId: { [Op.ne]: null } },
    attributes: ['deviceId'],
  });

  io.to(`child:${childId}`)
    .except(overrides.map((row) => `device:${row.deviceId}`))
    .emit('screen_time_updated', rule);
};

const updateRule = async (req, res) => {
  const child = await resolveChild(req.params.childId, req.user.id);
  if (!child) return res.status(404).json({ error: 'Child not found' });

  const invalid = validate(req.body);
  if (invalid) return res.status(400).json({ error: invalid });

  const scope = await resolveScope(child.id, req.query.deviceId ?? req.body.deviceId);
  if (scope.error) return res.status(400).json({ error: scope.error });

  const rule = await findOrCreateRule(child.id, scope.deviceId);

  // Whitelist updatable fields — never allow childId/deviceId/id reassignment
  // via body. `deviceId` in particular decides which devices obey this rule, so
  // letting it through here would let one PUT move a rule onto a sibling.
  const allowed = ['dailyLimitMinutes', 'schedule', 'bedtimeEnabled', 'bedtimeStart', 'bedtimeEnd', 'isActive'];
  const updates = {};
  for (const key of allowed) if (req.body[key] !== undefined) updates[key] = req.body[key];
  await rule.update(updates);

  await announceRule(req.app.get('io'), child.id, scope.deviceId, rule);

  return res.json(rule);
};

/**
 * DELETE /api/screen-time/:childId?deviceId=… — drop one device's exception so
 * it goes back to obeying the child's rule.
 *
 * Distinct from setting the device's limit back to the child's by hand, which
 * leaves an exception that merely happens to agree today and stops tracking the
 * child-wide rule the moment the parent edits it.
 */
const clearDeviceRule = async (req, res) => {
  const child = await resolveChild(req.params.childId, req.user.id);
  if (!child) return res.status(404).json({ error: 'Child not found' });

  const scope = await resolveScope(child.id, req.query.deviceId ?? req.body.deviceId);
  if (scope.error) return res.status(400).json({ error: scope.error });
  if (!scope.deviceId) {
    return res.status(400).json({ error: 'Name the device whose exception you want removed.' });
  }

  const removed = await ScreenTimeRule.destroy({ where: { childId: child.id, deviceId: scope.deviceId } });

  // Straight to the one device, which is now governed by the child's rule again.
  // The exception has already been destroyed, so `announceRule` would no longer
  // exclude it from a child-wide broadcast either.
  const childWide = await ScreenTimeRule.findOne({ where: { childId: child.id, deviceId: null } });
  await announceRule(req.app.get('io'), child.id, scope.deviceId, childWide);

  return res.json({ message: removed ? 'Device now follows the child rule' : 'No device rule to remove' });
};

// ── Extra minutes for today ───────────────────────────────────────────────────

/**
 * How far back a grant is worth reading.
 *
 * No device's "today" can reach further than this, whatever timezone it is in
 * (26 hours would do it; 48 leaves room for a laptop whose clock is wrong). The
 * parent's page filters the answer down to its own local day — see `listGrants`
 * for why the server does not try to decide which day a grant belongs to.
 */
const GRANT_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Grants older than this can apply to nobody's today and are swept on write. */
const GRANT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** One grant's ceiling. A daily limit tops out at 24h, and a top-up is not that. */
const MAX_GRANT_MINUTES = 240;
const MIN_GRANT_MINUTES = 5;

/**
 * GET /api/screen-time/:childId/grant — the extra minutes in play right now.
 *
 * Returns the raw rows within the window rather than a total for "today",
 * because this process cannot say when today started. It runs on Cloud Run in
 * UTC and the family is in Canada; a total computed here would be right for
 * about four hours a day and would reset in front of the parent at 20:00 — the
 * exact failure that made every evening's screen time double-count before
 * `usageDayWindow` existed.
 *
 * So the day boundary is applied by whoever knows one: the browser sums the
 * grants that fall inside its own local day, and the child's device does the
 * same against its own midnight when it spends them.
 *
 * Grants for a *device* are included in the child-wide read. They are not
 * exceptions to be discovered scope by scope — they are minutes this child was
 * given — and a parent looking at the shared tab should see the fifteen minutes
 * they gave the laptop ten minutes ago rather than an empty total.
 */
const listGrants = async (req, res) => {
  const child = await resolveChild(req.params.childId, req.user.id);
  if (!child) return res.status(404).json({ error: 'Child not found' });

  const scope = await resolveScope(child.id, req.query.deviceId);
  if (scope.error) return res.status(400).json({ error: scope.error });

  const where = { childId: child.id, createdAt: { [Op.gte]: new Date(Date.now() - GRANT_WINDOW_MS) } };
  // A device scope narrows to what that device can actually spend: its own
  // grants plus the child-wide ones it also receives. The same pair the sync
  // sends it, so the two screens cannot disagree about what a device has.
  if (scope.deviceId) where[Op.or] = [{ deviceId: null }, { deviceId: scope.deviceId }];

  const grants = await ScreenTimeGrant.findAll({ where, order: [['createdAt', 'DESC']] });

  return res.json({
    grants: grants.map((g) => ({
      id: g.id,
      minutes: g.minutes,
      deviceId: g.deviceId,
      grantedAt: g.createdAt.toISOString(),
    })),
  });
};

/**
 * POST /api/screen-time/:childId/grant — say yes to "can I have more time?".
 *
 * The request already existed on both lock screens and in the child app's
 * Messages; what did not exist was an answer. A parent who wanted to give
 * fifteen minutes had to raise `dailyLimitMinutes`, and then remember in the
 * morning to put it back — so the usual outcome was a limit that crept upwards
 * all term and a child who learned that asking works permanently.
 *
 * This does not touch the rule. It adds minutes that expire with the day, and
 * the device is told at once rather than at the next five-minute poll, because a
 * child who has just been locked out is standing next to the parent tapping it.
 */
const grantExtraTime = async (req, res) => {
  const child = await resolveChild(req.params.childId, req.user.id);
  if (!child) return res.status(404).json({ error: 'Child not found' });

  const minutes = req.body.minutes;
  if (!Number.isInteger(minutes) || minutes < MIN_GRANT_MINUTES || minutes > MAX_GRANT_MINUTES) {
    return res.status(400).json({
      error: `Extra time must be a whole number of minutes between ${MIN_GRANT_MINUTES} and ${MAX_GRANT_MINUTES}.`,
    });
  }

  const scope = await resolveScope(child.id, req.query.deviceId ?? req.body.deviceId);
  if (scope.error) return res.status(400).json({ error: scope.error });

  const grant = await ScreenTimeGrant.create({
    childId: child.id,
    deviceId: scope.deviceId,
    minutes,
    grantedBy: req.user.id,
  });

  // Swept here rather than on a schedule: this is the only write to the table,
  // it is rare, and a row this old cannot be inside any device's day.
  ScreenTimeGrant.destroy({
    where: { childId: child.id, createdAt: { [Op.lt]: new Date(Date.now() - GRANT_RETENTION_MS) } },
  }).catch(() => { /* housekeeping — never fail the grant over it */ });

  const io = req.app.get('io');
  if (io) {
    // Only the devices these minutes belong to. A child-wide grant reaches every
    // device the child owns, which is what "another fifteen minutes" means when
    // the parent has not narrowed it.
    io.to(scope.deviceId ? `device:${scope.deviceId}` : `child:${child.id}`)
      .emit('screen_time_granted', {
        minutes: grant.minutes,
        grantedAt: grant.createdAt.toISOString(),
      });
    // The parent's other open tabs, so the total updates without a reload.
    io.to(`parent:${req.user.id}`).emit('screen_time_grant_added', {
      childId: child.id, deviceId: scope.deviceId, minutes: grant.minutes,
    });
  }

  auditLog(req, {
    userId: req.user.id,
    action: 'screen_time.granted',
    entity: 'Child',
    entityId: child.id,
    metadata: { minutes, deviceId: scope.deviceId },
  });

  return res.status(201).json({
    id: grant.id,
    minutes: grant.minutes,
    deviceId: grant.deviceId,
    grantedAt: grant.createdAt.toISOString(),
  });
};

/**
 * The grants one device may spend, in the shape the sync sends.
 *
 * Lives here rather than in deviceController so the window and the read stay
 * beside the write that produces them; `resolveScreenTimeGrants` says why they
 * add up instead of overriding.
 */
const grantsForDevice = async (childId, deviceId) => {
  const rows = await ScreenTimeGrant.findAll({
    where: {
      childId,
      createdAt: { [Op.gte]: new Date(Date.now() - GRANT_WINDOW_MS) },
      [Op.or]: [{ deviceId: null }, { deviceId }],
    },
    order: [['createdAt', 'ASC']],
  });
  return resolveScreenTimeGrants(rows);
};

module.exports = {
  getRule, updateRule, clearDeviceRule,
  listGrants, grantExtraTime, grantsForDevice,
  __testing: { GRANT_WINDOW_MS, MAX_GRANT_MINUTES, MIN_GRANT_MINUTES },
};

const { ScreenTimeRule, Child, Device } = require('../models');
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

  const io = req.app.get('io');
  // Only the devices this rule governs. A device with its own rule is not
  // listening for the child-wide one — it would re-sync and correctly discard
  // what it was told, which is work for nothing on a battery.
  io.to(scope.deviceId ? `device:${scope.deviceId}` : `child:${child.id}`)
    .emit('screen_time_updated', rule);

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

  const io = req.app.get('io');
  const childWide = await ScreenTimeRule.findOne({ where: { childId: child.id, deviceId: null } });
  io.to(`device:${scope.deviceId}`).emit('screen_time_updated', childWide);

  return res.json({ message: removed ? 'Device now follows the child rule' : 'No device rule to remove' });
};

module.exports = { getRule, updateRule, clearDeviceRule };

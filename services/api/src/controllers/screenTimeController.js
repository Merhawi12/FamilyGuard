const { ScreenTimeRule, Child } = require('../models');
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

const getRule = async (req, res) => {
  const child = await resolveChild(req.params.childId, req.user.id);
  if (!child) return res.status(404).json({ error: 'Child not found' });

  let rule = await ScreenTimeRule.findOne({ where: { childId: child.id } });
  if (!rule) rule = await ScreenTimeRule.create({ childId: child.id });
  res.json(rule);
};

const updateRule = async (req, res) => {
  const child = await resolveChild(req.params.childId, req.user.id);
  if (!child) return res.status(404).json({ error: 'Child not found' });

  const invalid = validate(req.body);
  if (invalid) return res.status(400).json({ error: invalid });

  let rule = await ScreenTimeRule.findOne({ where: { childId: child.id } });
  if (!rule) rule = await ScreenTimeRule.create({ childId: child.id });

  // Whitelist updatable fields — never allow childId/id reassignment via body
  const allowed = ['dailyLimitMinutes', 'schedule', 'bedtimeEnabled', 'bedtimeStart', 'bedtimeEnd', 'isActive'];
  const updates = {};
  for (const key of allowed) if (req.body[key] !== undefined) updates[key] = req.body[key];
  await rule.update(updates);

  const io = req.app.get('io');
  io.to(`child:${child.id}`).emit('screen_time_updated', rule);

  res.json(rule);
};

module.exports = { getRule, updateRule };

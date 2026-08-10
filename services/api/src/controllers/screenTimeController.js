const { ScreenTimeRule, Child } = require('../models');
const { isUuid } = require('../utils/ids');

// A malformed id is "not found", not a database error — see utils/ids.js for why
// this has to be checked before the query rather than after it.
const resolveChild = (childId, parentId) =>
  (isUuid(childId) ? Child.findOne({ where: { id: childId, parentId } }) : null);

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

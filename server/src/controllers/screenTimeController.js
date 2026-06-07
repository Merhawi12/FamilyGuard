const { ScreenTimeRule, Child } = require('../models');

const getRule = async (req, res) => {
  const child = await Child.findOne({ where: { id: req.params.childId, parentId: req.user.id } });
  if (!child) return res.status(404).json({ error: 'Child not found' });

  let rule = await ScreenTimeRule.findOne({ where: { childId: child.id } });
  if (!rule) rule = await ScreenTimeRule.create({ childId: child.id });
  res.json(rule);
};

const updateRule = async (req, res) => {
  const child = await Child.findOne({ where: { id: req.params.childId, parentId: req.user.id } });
  if (!child) return res.status(404).json({ error: 'Child not found' });

  let rule = await ScreenTimeRule.findOne({ where: { childId: child.id } });
  if (!rule) rule = await ScreenTimeRule.create({ childId: child.id });

  await rule.update(req.body);

  const io = req.app.get('io');
  io.to(`child:${child.id}`).emit('screen_time_updated', rule);

  res.json(rule);
};

module.exports = { getRule, updateRule };

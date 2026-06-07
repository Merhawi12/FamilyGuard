const { AppRule, WebsiteRule, Child } = require('../models');

const verifyChild = async (parentId, childId) => Child.findOne({ where: { id: childId, parentId } });

const getAppRules = async (req, res) => {
  if (!(await verifyChild(req.user.id, req.params.childId))) return res.status(404).json({ error: 'Child not found' });
  const rules = await AppRule.findAll({ where: { childId: req.params.childId } });
  res.json(rules);
};

const addAppRule = async (req, res) => {
  if (!(await verifyChild(req.user.id, req.params.childId))) return res.status(404).json({ error: 'Child not found' });
  const rule = await AppRule.create({ childId: req.params.childId, ...req.body });
  req.app.get('io').to(`child:${req.params.childId}`).emit('rules_updated', { type: 'app' });
  res.status(201).json(rule);
};

const removeAppRule = async (req, res) => {
  const rule = await AppRule.findOne({ where: { id: req.params.ruleId, childId: req.params.childId } });
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  await rule.destroy();
  res.json({ message: 'Rule removed' });
};

const getWebsiteRules = async (req, res) => {
  if (!(await verifyChild(req.user.id, req.params.childId))) return res.status(404).json({ error: 'Child not found' });
  const rules = await WebsiteRule.findAll({ where: { childId: req.params.childId } });
  res.json(rules);
};

const addWebsiteRule = async (req, res) => {
  if (!(await verifyChild(req.user.id, req.params.childId))) return res.status(404).json({ error: 'Child not found' });
  const rule = await WebsiteRule.create({ childId: req.params.childId, ...req.body });
  req.app.get('io').to(`child:${req.params.childId}`).emit('rules_updated', { type: 'website' });
  res.status(201).json(rule);
};

const removeWebsiteRule = async (req, res) => {
  const rule = await WebsiteRule.findOne({ where: { id: req.params.ruleId, childId: req.params.childId } });
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  await rule.destroy();
  res.json({ message: 'Rule removed' });
};

module.exports = { getAppRules, addAppRule, removeAppRule, getWebsiteRules, addWebsiteRule, removeWebsiteRule };

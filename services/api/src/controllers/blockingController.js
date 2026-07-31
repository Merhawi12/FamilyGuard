const { AppRule, WebsiteRule, Child } = require('../models');
const { normalizeDomain } = require('../utils/domain');

const verifyChild = async (parentId, childId) => Child.findOne({ where: { id: childId, parentId } });

const getAppRules = async (req, res) => {
  if (!(await verifyChild(req.user.id, req.params.childId))) return res.status(404).json({ error: 'Child not found' });
  const rules = await AppRule.findAll({ where: { childId: req.params.childId } });
  res.json(rules);
};

const addAppRule = async (req, res) => {
  if (!(await verifyChild(req.user.id, req.params.childId))) return res.status(404).json({ error: 'Child not found' });
  // childId last so a body-supplied childId cannot override the verified param
  const rule = await AppRule.create({ ...req.body, childId: req.params.childId });
  req.app.get('io').to(`child:${req.params.childId}`).emit('rules_updated', { type: 'app' });
  res.status(201).json(rule);
};

const removeAppRule = async (req, res) => {
  if (!(await verifyChild(req.user.id, req.params.childId))) return res.status(404).json({ error: 'Child not found' });
  const rule = await AppRule.findOne({ where: { id: req.params.ruleId, childId: req.params.childId } });
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  await rule.destroy();
  req.app.get('io').to(`child:${req.params.childId}`).emit('rules_updated', { type: 'app' });
  res.json({ message: 'Rule removed' });
};

const getWebsiteRules = async (req, res) => {
  if (!(await verifyChild(req.user.id, req.params.childId))) return res.status(404).json({ error: 'Child not found' });
  const rules = await WebsiteRule.findAll({ where: { childId: req.params.childId } });
  res.json(rules);
};

const addWebsiteRule = async (req, res) => {
  if (!(await verifyChild(req.user.id, req.params.childId))) return res.status(404).json({ error: 'Child not found' });

  /**
   * The device enforces these by matching DNS queries, so a rule has to be a
   * bare hostname. Parents paste what the address bar shows, so normalise it
   * here and reject anything that could never match — silently storing
   * `https://youtube.com/feed` would look like it worked and block nothing.
   *
   * A category-only rule carries no url and is left alone.
   */
  const updates = { ...req.body };
  if (updates.url != null && String(updates.url).trim() !== '') {
    const domain = normalizeDomain(updates.url);
    if (!domain) {
      return res.status(400).json({ error: 'Enter a website domain, for example example.com' });
    }
    updates.url = domain;
  }

  // childId last so a body-supplied childId cannot override the verified param
  const rule = await WebsiteRule.create({ ...updates, childId: req.params.childId });
  req.app.get('io').to(`child:${req.params.childId}`).emit('rules_updated', { type: 'website' });
  res.status(201).json(rule);
};

const removeWebsiteRule = async (req, res) => {
  if (!(await verifyChild(req.user.id, req.params.childId))) return res.status(404).json({ error: 'Child not found' });
  const rule = await WebsiteRule.findOne({ where: { id: req.params.ruleId, childId: req.params.childId } });
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  await rule.destroy();
  req.app.get('io').to(`child:${req.params.childId}`).emit('rules_updated', { type: 'website' });
  res.json({ message: 'Rule removed' });
};

module.exports = { getAppRules, addAppRule, removeAppRule, getWebsiteRules, addWebsiteRule, removeWebsiteRule };

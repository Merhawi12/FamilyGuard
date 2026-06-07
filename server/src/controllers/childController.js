const { Child, ScreenTimeRule } = require('../models');

const getChildren = async (req, res) => {
  const children = await Child.findAll({
    where: { parentId: req.user.id, isActive: true },
    include: [{ association: 'devices' }, { association: 'screenTimeRule' }],
  });
  res.json(children);
};

const createChild = async (req, res) => {
  try {
    const { name, age, avatar } = req.body;
    const child = await Child.create({ parentId: req.user.id, name, age, avatar });
    await ScreenTimeRule.create({ childId: child.id });
    res.status(201).json(child);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const updateChild = async (req, res) => {
  const child = await Child.findOne({ where: { id: req.params.id, parentId: req.user.id } });
  if (!child) return res.status(404).json({ error: 'Child not found' });
  await child.update(req.body);
  res.json(child);
};

const deleteChild = async (req, res) => {
  const child = await Child.findOne({ where: { id: req.params.id, parentId: req.user.id } });
  if (!child) return res.status(404).json({ error: 'Child not found' });
  await child.update({ isActive: false });
  res.json({ message: 'Child removed' });
};

module.exports = { getChildren, createChild, updateChild, deleteChild };

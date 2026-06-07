const { User } = require('../models');
const { Op } = require('sequelize');

const listClients = async (req, res) => {
  try {
    const clients = await User.findAll({
      where: { role: { [Op.ne]: 'admin' } },
      attributes: ['id', 'name', 'email', 'plan', 'role', 'isActive', 'trialEndsAt', 'createdAt'],
      order: [['createdAt', 'DESC']],
    });
    res.json(clients);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const toggleBlock = async (req, res) => {
  try {
    const client = await User.findOne({ where: { id: req.params.id, role: { [Op.ne]: 'admin' } } });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    client.isActive = !client.isActive;
    await client.save();
    res.json({ id: client.id, isActive: client.isActive });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const updatePlan = async (req, res) => {
  try {
    const { plan } = req.body;
    const allowed = ['free', 'premium', 'suspended'];
    if (!allowed.includes(plan)) return res.status(400).json({ error: 'Invalid plan' });

    const client = await User.findOne({ where: { id: req.params.id, role: { [Op.ne]: 'admin' } } });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    client.plan = plan;
    // auto-block on suspension, auto-unblock when upgrading
    if (plan === 'suspended') client.isActive = false;
    if (plan === 'premium') client.isActive = true;
    await client.save();
    res.json({ id: client.id, plan: client.plan, isActive: client.isActive });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const deleteClient = async (req, res) => {
  try {
    const client = await User.findOne({ where: { id: req.params.id, role: { [Op.ne]: 'admin' } } });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    await client.destroy();
    res.json({ message: 'Client deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = { listClients, toggleBlock, updatePlan, deleteClient };

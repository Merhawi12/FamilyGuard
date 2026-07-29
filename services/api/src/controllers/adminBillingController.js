const { Transaction, User } = require('../models');

// GET /admin/transactions
const listTransactions = async (req, res, next) => {
  try {
    const { userId, status, plan, limit = 50, offset = 0 } = req.query;
    const where = {};
    if (userId) where.userId = userId;
    if (status) where.status = status;
    if (plan) where.plan = plan;

    const transactions = await Transaction.findAndCountAll({
      where,
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'] }],
      order: [['createdAt', 'DESC']],
      limit: Math.min(parseInt(limit), 200),
      offset: parseInt(offset),
    });

    res.json(transactions);
  } catch (err) {
    next(err);
  }
};

// GET /admin/users/:id/transactions
const listUserTransactions = async (req, res, next) => {
  try {
    const transactions = await Transaction.findAll({
      where: { userId: req.params.id },
      order: [['createdAt', 'DESC']],
    });
    res.json(transactions);
  } catch (err) {
    next(err);
  }
};

module.exports = { listTransactions, listUserTransactions };

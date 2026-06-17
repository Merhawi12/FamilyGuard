const { Op, fn, col } = require('sequelize');
const { User, Transaction, Session } = require('../models');

// GET /admin/analytics
const getAnalytics = async (req, res) => {
  try {
    const [totalUsers, byPlan, byRole, activeSessions, mfaEnabledCount] = await Promise.all([
      User.count(),
      User.findAll({ attributes: ['plan', [fn('COUNT', col('id')), 'count']], group: ['plan'] }),
      User.findAll({ attributes: ['role', [fn('COUNT', col('id')), 'count']], group: ['role'] }),
      Session.count({ where: { revoked: false } }),
      User.count({ where: { mfaEnabled: true } }),
    ]);

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentUsers = await User.findAll({
      where: { createdAt: { [Op.gte]: thirtyDaysAgo } },
      attributes: ['createdAt'],
    });
    const signupsByDay = {};
    recentUsers.forEach((u) => {
      const day = u.createdAt.toISOString().slice(0, 10);
      signupsByDay[day] = (signupsByDay[day] || 0) + 1;
    });

    const revenueRows = await Transaction.findAll({
      where: { status: 'succeeded', amount: { [Op.ne]: null } },
      attributes: [[fn('SUM', col('amount')), 'total']],
    });
    const totalRevenueCents = revenueRows[0]?.get('total') || 0;

    res.json({
      totalUsers,
      byPlan: byPlan.map((r) => ({ plan: r.plan, count: Number(r.get('count')) })),
      byRole: byRole.map((r) => ({ role: r.role, count: Number(r.get('count')) })),
      activeSessions,
      mfaAdoptionRate: totalUsers ? Math.round((mfaEnabledCount / totalUsers) * 100) : 0,
      totalRevenue: Number(totalRevenueCents) / 100,
      signupsByDay,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = { getAnalytics };

const { Op, fn, col } = require('sequelize');
const { User, Transaction, Session } = require('../models');
const { countGrouped } = require('../utils/aggregate');

/** The signup window the Overview screen charts. */
const SIGNUP_WINDOW_DAYS = 30;

// GET /admin/analytics
const getAnalytics = async (req, res, next) => {
  try {
    const windowStart = new Date(Date.now() - SIGNUP_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    /**
     * Every figure on the Overview screen, in one round trip's worth of waiting.
     *
     * The signup and revenue queries used to be awaited one after the other,
     * below this block — three serial waits to answer one screen that needs all
     * three and orders none of them. They join the same `Promise.all` now, which
     * costs the database nothing extra and takes the slowest of the three rather
     * than their sum.
     */
    const [totalUsers, byPlan, byRole, activeSessions, mfaEnabledCount, recentUsers, revenueRows] =
      await Promise.all([
        User.count(),
        countGrouped(User, 'plan'),
        countGrouped(User, 'role'),
        Session.count({ where: { revoked: false } }),
        User.count({ where: { mfaEnabled: true } }),
        /**
         * Only the column the buckets are built from.
         *
         * This selected whole `User` rows — every column of every account
         * created in the last thirty days — to read one timestamp off each. On a
         * platform doing well that is the largest response the console produces,
         * and it grows with the thing the chart is celebrating.
         *
         * It is still bucketed in JavaScript rather than by SQL, and that is
         * deliberate: date truncation is spelled differently on SQLite and
         * Postgres (`strftime` vs `date_trunc`), and this codebase has been
         * caught by exactly that difference before. `utils/aggregate.js` says
         * the same thing at more length. The row count here is bounded by a
         * month of signups; the column count was not, and was the real cost.
         */
        User.findAll({
          where: { createdAt: { [Op.gte]: windowStart } },
          attributes: ['createdAt'],
          raw: true,
        }),
        Transaction.findAll({
          where: { status: 'succeeded', amount: { [Op.ne]: null } },
          attributes: [[fn('SUM', col('amount')), 'total']],
          raw: true,
        }),
      ]);

    const signupsByDay = {};
    recentUsers.forEach((u) => {
      // Re-wrapped and checked: a row whose timestamp will not parse belongs in
      // no day bucket, and must not cost the whole Overview a 500.
      const created = new Date(u.createdAt);
      if (Number.isNaN(created.getTime())) return;
      const day = created.toISOString().slice(0, 10);
      signupsByDay[day] = (signupsByDay[day] || 0) + 1;
    });

    const totalRevenueCents = revenueRows[0]?.total || 0;

    res.json({
      totalUsers,
      byPlan: [...byPlan].map(([plan, count]) => ({ plan, count })),
      byRole: [...byRole].map(([role, count]) => ({ role, count })),
      activeSessions,
      mfaAdoptionRate: totalUsers ? Math.round((mfaEnabledCount / totalUsers) * 100) : 0,
      totalRevenue: Number(totalRevenueCents) / 100,
      signupsByDay,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { getAnalytics };

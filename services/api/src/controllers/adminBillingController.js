const { Op } = require('sequelize');
const { Transaction, User } = require('../models');
const { parsePagination } = require('../utils/pagination');
const { likeOperator } = require('../utils/queryOperators');
const { isUuid } = require('../utils/ids');
const { STAFF_ROLES } = require('../config/roles');
const { PLANS, PLAN_KEYS, PAID_PLAN_KEYS, SUSPENDED_PLAN, planLabel } = require('../config/plans');

/**
 * The console's billing screen: what the platform earns, and every payment
 * behind it.
 *
 * Every number here is derived from two tables — the transaction log Stripe's
 * webhook writes, and the plan each customer is on. Nothing is projected or
 * modelled. Where a figure a finance screen normally shows cannot be computed
 * from those two (a per-cohort LTV, a churn forecast), it is not shown.
 *
 * The transaction types the webhook writes are `checkout_completed`,
 * `invoice_paid`, `invoice_failed`, `subscription_updated` and
 * `subscription_cancelled`; only the first two carry money that landed.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Staff never buy a subscription, so they are no part of any billing number. */
const CUSTOMERS = { role: { [Op.notIn]: STAFF_ROLES } };

/** A payment that actually landed, as opposed to a subscription status change. */
const BILLED = 'succeeded';

/** How far back the revenue chart can look. Its longest range is twelve months. */
const TREND_DAYS = 366;

const startOfUtcDay = (ms) => {
  const date = new Date(ms);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
};

/**
 * Bucket totals over a set of period edges.
 *
 * `edges` is ascending and holds one more entry than there are buckets — bucket
 * `i` is `[edges[i], edges[i + 1])` — so the last period has a real end and a
 * payment taken this minute cannot fall off the chart. Scanned backwards
 * because the rows arriving here are mostly recent.
 */
const bucketize = (edges, payments) => {
  const totals = new Array(edges.length - 1).fill(0);
  const first = edges[0];
  const last = edges[edges.length - 1];

  payments.forEach(({ at, amount }) => {
    if (at < first || at >= last) return;
    let i = totals.length - 1;
    while (i > 0 && at < edges[i]) i -= 1;
    totals[i] += amount;
  });

  return totals.map((amount, i) => ({ start: new Date(edges[i]).toISOString(), amount }));
};

/** `count` periods of `days` each, the last of them ending at tomorrow's UTC midnight. */
const fixedEdges = (count, days, now) => {
  const end = startOfUtcDay(now) + DAY_MS;
  const step = days * DAY_MS;
  return Array.from({ length: count + 1 }, (_, i) => end - (count - i) * step);
};

/** `count` calendar months back from the current one, which is the last bucket. */
const monthEdges = (count, now) => {
  const here = new Date(now);
  return Array.from({ length: count + 1 }, (_, i) => Date.UTC(
    here.getUTCFullYear(),
    here.getUTCMonth() - (count - 1) + i,
    1
  ));
};

/**
 * Everything the tiles, the revenue chart and the plan mix report.
 *
 * Unfiltered on purpose, the same rule the directory and the fleet follow: the
 * summary describes the platform, so it must not move when the invoice table
 * below it is narrowed to one plan or one search term.
 */
const billingSummary = async () => {
  const now = Date.now();
  const monthAgo = new Date(now - 30 * DAY_MS);
  const twoMonthsAgo = new Date(now - 60 * DAY_MS);

  const [planRows, billedRows, changeRows] = await Promise.all([
    User.findAll({ where: CUSTOMERS, attributes: ['plan'] }),
    // A year of payments, two columns wide. Bucketed in JS rather than with
    // three GROUP BY queries: date truncation is spelled differently on SQLite
    // and Postgres, and the console must not report a different revenue trend
    // in the test suite than it does on Cloud SQL.
    Transaction.findAll({
      where: { status: BILLED, createdAt: { [Op.gte]: new Date(now - TREND_DAYS * DAY_MS) } },
      attributes: ['amount', 'currency', 'createdAt'],
    }),
    // Subscriptions won and lost over the two windows the deltas compare.
    Transaction.findAll({
      where: {
        type: ['checkout_completed', 'subscription_cancelled', 'invoice_failed'],
        createdAt: { [Op.gte]: twoMonthsAgo },
      },
      attributes: ['type', 'createdAt'],
    }),
  ]);

  // ── The plan mix ───────────────────────────────────────────────────────────
  const counted = new Map(planRows.map((u) => [u.plan, 0]));
  planRows.forEach((u) => { counted.set(u.plan, counted.get(u.plan) + 1); });

  // Every sellable plan appears whether or not anyone is on it — a tier with no
  // subscribers is a fact, and a legend that drops it reads as a broken chart.
  // Suspended accounts only appear once there are some.
  const customers = planRows.length;
  const shownPlans = [...PLAN_KEYS, ...(counted.get(SUSPENDED_PLAN) ? [SUSPENDED_PLAN] : [])];
  const plans = shownPlans.map((key) => {
    const subscribers = counted.get(key) || 0;
    const amount = PLANS[key]?.amount ?? 0;
    return {
      key,
      label: key === SUSPENDED_PLAN ? 'Suspended' : planLabel(key),
      amount,
      paid: amount > 0,
      subscribers,
      share: customers === 0 ? 0 : Math.round((subscribers / customers) * 1000) / 10,
      // What this tier contributes to the run rate, per month.
      mrr: subscribers * amount,
    };
  });

  const subscribers = PAID_PLAN_KEYS.reduce((sum, key) => sum + (counted.get(key) || 0), 0);
  const mrr = plans.reduce((sum, plan) => sum + plan.mrr, 0);

  // ── Money that actually landed ─────────────────────────────────────────────
  const currencies = new Map();
  const payments = [];
  billedRows.forEach((row) => {
    // Re-wrapped and checked: the two engines hand a timestamp column back
    // differently, and a row that will not parse must drop out of a bucket
    // rather than turn the whole screen into a 500.
    const at = new Date(row.createdAt).getTime();
    if (Number.isNaN(at)) return;
    payments.push({ at, amount: row.amount || 0 });
    const currency = (row.currency || 'usd').toLowerCase();
    currencies.set(currency, (currencies.get(currency) || 0) + 1);
  });

  const since = (from) => payments
    .filter(({ at }) => at >= from.getTime())
    .reduce((sum, p) => sum + p.amount, 0);
  const billedMonth = since(monthAgo);
  const billedPrevious = since(twoMonthsAgo) - billedMonth;

  // ── Won and lost ───────────────────────────────────────────────────────────
  const inWindow = (type, from, to) => changeRows.filter((row) => {
    if (row.type !== type) return false;
    const at = new Date(row.createdAt).getTime();
    return !Number.isNaN(at) && at >= from && (to === undefined || at < to);
  }).length;

  const monthStart = monthAgo.getTime();
  const previousStart = twoMonthsAgo.getTime();
  const won = inWindow('checkout_completed', monthStart);
  const lost = inWindow('subscription_cancelled', monthStart);
  const wonBefore = inWindow('checkout_completed', previousStart, monthStart);
  const lostBefore = inWindow('subscription_cancelled', previousStart, monthStart);
  const failedPayments = inWindow('invoice_failed', monthStart);

  // Where the subscriber count stood at the start of each window, walked back
  // from today through what was won and lost. Approximate by nature — a plan
  // changed by hand in the console leaves no transaction behind — which is why
  // churn is reported as null rather than as zero when there is no base.
  const baseNow = Math.max(subscribers - won + lost, 0);
  const baseBefore = Math.max(baseNow - wonBefore + lostBefore, 0);
  const rate = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
  const percent = (now_, before) => (before > 0 ? Math.round(((now_ - before) / before) * 1000) / 10 : null);

  return {
    // The platform bills one currency; this is which, so the screen never
    // labels a total with a symbol the payments were not taken in.
    currency: [...currencies.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'usd',
    /** Run rate in cents per month: every paid subscription at its list price. */
    mrr,
    /** How that run rate compares with what was actually billed last month. */
    mrrChange: percent(mrr, billedPrevious),
    billed: { month: billedMonth, previousMonth: billedPrevious },
    subscribers,
    subscriberChange: percent(subscribers, baseNow),
    customers,
    /** Average revenue per paying subscription, cents per month. */
    arpu: subscribers === 0 ? 0 : Math.round(mrr / subscribers),
    churn: {
      rate: rate(lost, baseNow),
      previousRate: rate(lostBefore, baseBefore),
      cancellations: lost,
      newSubscriptions: won,
    },
    failedPayments,
    plans,
    revenue: {
      day: bucketize(fixedEdges(30, 1, now), payments),
      week: bucketize(fixedEdges(12, 7, now), payments),
      month: bucketize(monthEdges(12, now), payments),
    },
  };
};

// GET /admin/transactions — the payment log, with search, status and plan filters.
const listTransactions = async (req, res, next) => {
  try {
    const { limit, offset } = parsePagination(req.query, { max: 200, defaultLimit: 50 });
    const { userId, status, plan, search } = req.query;

    // Each clause is its own object so none can overwrite another's `Op.or`.
    const and = [];
    if (userId) and.push({ userId });
    if (status) and.push({ status });
    if (plan) and.push({ plan });
    if (search) {
      const contains = { [likeOperator()]: `%${search}%` };
      and.push({
        [Op.or]: [
          { '$user.name$': contains },
          { '$user.email$': contains },
          { type: contains },
        ],
      });
    }

    const { rows, count } = await Transaction.findAndCountAll({
      where: and.length ? { [Op.and]: and } : {},
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email', 'plan'] }],
      order: [['createdAt', 'DESC']],
      limit,
      offset,
      // Belongs-to, so each transaction still yields one row and the count needs
      // no DISTINCT — but `$user.email$` only resolves against a real join, not
      // against a paginated sub-select.
      subQuery: false,
    });

    const summary = await billingSummary();

    res.json({ rows, count, summary });
  } catch (err) {
    next(err);
  }
};

// GET /admin/users/:id/transactions
const listUserTransactions = async (req, res, next) => {
  try {
    // A malformed id has no transactions rather than being a database error —
    // see utils/ids.js.
    if (!isUuid(req.params.id)) return res.json([]);

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

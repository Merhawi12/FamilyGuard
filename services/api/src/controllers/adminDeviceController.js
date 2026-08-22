const { Op } = require('sequelize');
const { sequelize } = require('../config/db');
const { Device, Child, User, AppRule, WebsiteRule, ScreenTimeRule } = require('../models');
const { parsePagination } = require('../utils/pagination');
const { likeOperator } = require('../utils/queryOperators');
const { countGrouped } = require('../utils/aggregate');

/**
 * The console's view of the device fleet — every linked phone, tablet and laptop
 * across every customer, not just one parent's own.
 *
 * Read-only on purpose. A device is enrolled by its own linking code and
 * unenrolled by the parent who owns it; nothing here lets support reach into a
 * child's phone, so the screen answers "is the fleet reporting?" rather than
 * offering remote control it has no channel for.
 */

/** Device types the apps offer. Mirrors DEVICE_TYPES in the device controller. */
const PLATFORMS = ['android', 'ios', 'windows', 'mac'];

/**
 * How long after its last heartbeat a device still counts as online.
 *
 * The child app checks in every five minutes, so this is three missed
 * heartbeats — long enough that a phone in a lift or a slow sync is not
 * reported as offline, short enough that a phone switched off this morning is.
 */
const ONLINE_WINDOW_MS = 15 * 60 * 1000;

/** A device that has reported inside this window is considered up to date. */
const SYNCED_WINDOW_MS = 24 * 60 * 60 * 1000;

const statusOf = (device, onlineSince) => {
  if (!device.isLinked) return 'pending';
  if (device.lastSeen && new Date(device.lastSeen) >= onlineSince) return 'online';
  return 'offline';
};

/** Rule counts for the children on this page, so the row can show its policy. */
const policiesFor = async (childIds) => {
  if (childIds.length === 0) return new Map();

  // Counted in JS rather than with GROUP BY: a child has a handful of rules, and
  // three small selects keep the aggregate off the dialect's column-naming.
  const [appRules, websiteRules, screenTimeRules] = await Promise.all([
    AppRule.findAll({ where: { childId: childIds }, attributes: ['childId'] }),
    WebsiteRule.findAll({ where: { childId: childIds }, attributes: ['childId'] }),
    ScreenTimeRule.findAll({ where: { childId: childIds }, attributes: ['childId', 'dailyLimitMinutes', 'bedtimeEnabled'] }),
  ]);

  const policies = new Map(childIds.map((id) => [id, {
    appRules: 0, websiteRules: 0, dailyLimitMinutes: null, bedtimeEnabled: false,
  }]));

  appRules.forEach((r) => { policies.get(r.childId).appRules += 1; });
  websiteRules.forEach((r) => { policies.get(r.childId).websiteRules += 1; });
  screenTimeRules.forEach((r) => {
    const policy = policies.get(r.childId);
    policy.dailyLimitMinutes = r.dailyLimitMinutes;
    policy.bedtimeEnabled = !!r.bedtimeEnabled;
  });

  return policies;
};

/**
 * Fleet-wide totals for the summary tiles.
 *
 * Deliberately unfiltered: the tiles report the platform, so they must not move
 * when someone narrows the table to one platform or types in the filter box.
 */
const fleetSummary = async (onlineSince) => {
  const active = { isActive: true };
  const [total, online, pending, syncedRecently, platformCounts] = await Promise.all([
    Device.count({ where: active }),
    Device.count({ where: { ...active, isLinked: true, lastSeen: { [Op.gte]: onlineSince } } }),
    Device.count({ where: { ...active, isLinked: false } }),
    Device.count({
      where: { ...active, isLinked: true, lastSeen: { [Op.gte]: new Date(Date.now() - SYNCED_WINDOW_MS) } },
    }),
    // Grouped in the database. This used to select every active device in the
    // fleet with its `type` projected and count the four platforms with
    // `filter().length` — a full table scan whose cost grows with the customer
    // base every time an operator opens this screen, to produce four integers.
    countGrouped(Device, 'type', active),
  ]);

  const linked = total - pending;
  const byPlatform = PLATFORMS.map((platform) => ({
    platform,
    count: platformCounts.get(platform) || 0,
  }));
  // Anything the apps do not offer still has to be counted somewhere, or the
  // breakdown silently adds up to less than the fleet. Derived from `total`
  // rather than from the sum of the grouped rows so a NULL `type` — which forms
  // its own group and matches no platform — is still counted here.
  const other = total - byPlatform.reduce((sum, p) => sum + p.count, 0);
  if (other > 0) byPlatform.push({ platform: 'other', count: other });

  return {
    total,
    linked,
    online,
    offline: linked - online,
    pending,
    // Share of enrolled devices that reported in the last day. An empty fleet is
    // 100% reporting rather than 0% — nothing is behind.
    syncRate: linked === 0 ? 100 : Math.round((syncedRecently / linked) * 100),
    // Last-seen buckets, derived from the counts above rather than re-queried.
    reporting: {
      live: online,
      today: Math.max(syncedRecently - online, 0),
      stale: Math.max(linked - syncedRecently, 0),
      pending,
    },
    byPlatform,
    onlineWindowMinutes: ONLINE_WINDOW_MS / 60000,
  };
};

// GET /admin/devices — the fleet, with search, platform and status filters.
const listDevices = async (req, res, next) => {
  try {
    const { limit, offset } = parsePagination(req.query, { max: 200, defaultLimit: 25 });
    const { search, platform, status } = req.query;
    const onlineSince = new Date(Date.now() - ONLINE_WINDOW_MS);

    // Every clause is ANDed as its own object: search and the status filter both
    // want an Op.or, and two of those on one `where` would overwrite each other.
    const and = [{ isActive: true }];

    if (platform && PLATFORMS.includes(platform)) and.push({ type: platform });

    if (status === 'pending') and.push({ isLinked: false });
    if (status === 'online') and.push({ isLinked: true, lastSeen: { [Op.gte]: onlineSince } });
    if (status === 'offline') {
      and.push({
        isLinked: true,
        [Op.or]: [{ lastSeen: null }, { lastSeen: { [Op.lt]: onlineSince } }],
      });
    }

    if (search) {
      const contains = { [likeOperator()]: `%${search}%` };
      and.push({
        [Op.or]: [
          { name: contains },
          { '$child.name$': contains },
          { '$child.parent.name$': contains },
          { '$child.parent.email$': contains },
        ],
      });
    }

    const { rows, count } = await Device.findAndCountAll({
      where: { [Op.and]: and },
      include: [{
        model: Child,
        as: 'child',
        attributes: ['id', 'name', 'age'],
        include: [{ model: User, as: 'parent', attributes: ['id', 'name', 'email', 'plan', 'isActive'] }],
      }],
      // Most recently seen first, with never-seen devices last. The literal is
      // what makes that last part dialect-safe: `DESC` alone puts NULLs first on
      // Postgres and last on SQLite, so the console would order its fleet one way
      // in the test suite and the other way in production.
      // Qualified, because the query joins two more tables and an unqualified
      // column in a literal is only unambiguous by luck.
      order: [
        [sequelize.literal('"Device"."last_seen" IS NULL'), 'ASC'],
        ['lastSeen', 'DESC'],
        ['createdAt', 'DESC'],
      ],
      limit,
      offset,
      // The joins are all belongs-to, so each device still yields one row and the
      // count needs no DISTINCT — but the nested `$child.parent.email$` search
      // only resolves against a real join, not against a paginated sub-select.
      subQuery: false,
    });

    // Independent of each other, so they overlap rather than queue: the summary
    // is fleet-wide and the policies are for this page's children only.
    const [policies, summary] = await Promise.all([
      policiesFor([...new Set(rows.map((d) => d.childId))]),
      fleetSummary(onlineSince),
    ]);

    res.json({
      count,
      // Shaped by hand rather than returned raw: `pushToken` is a credential the
      // console has no use for, and a row carries fields the model does not
      // store (its status, its child's policy).
      rows: rows.map((device) => ({
        id: device.id,
        name: device.name,
        type: device.type,
        osVersion: device.osVersion || null,
        isLinked: device.isLinked,
        status: statusOf(device, onlineSince),
        lastSeen: device.lastSeen,
        createdAt: device.createdAt,
        pushRegistered: !!device.pushToken,
        child: device.child ? { id: device.child.id, name: device.child.name, age: device.child.age } : null,
        owner: device.child?.parent
          ? {
            id: device.child.parent.id,
            name: device.child.parent.name,
            email: device.child.parent.email,
            plan: device.child.parent.plan,
            isActive: device.child.parent.isActive,
          }
          : null,
        policy: policies.get(device.childId) || null,
      })),
      summary,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { listDevices, PLATFORMS, ONLINE_WINDOW_MS };

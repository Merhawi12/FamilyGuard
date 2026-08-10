/**
 * Turning filter rules into the list of domains a device blocks.
 *
 * Three things want to say what a child may reach, and until now only one of
 * them could:
 *
 *   - the parent's own website rules      (`WebsiteRule`, per child)
 *   - the same rules by category          (stored, never enforced — no url)
 *   - the platform-wide policy            (the console's Content Filtering screen)
 *
 * The device blocks DNS names and nothing else, so all three have to arrive as
 * hostnames in the `websiteRules` payload. That expansion happens here, once,
 * rather than in the device — a child app that had to understand categories
 * would have to be updated every time the catalogue changed, and the millions of
 * installed copies are exactly the thing that cannot be updated.
 *
 * Precedence, most specific first:
 *
 *   1. a child's own `allow` rule for a domain   — always wins
 *   2. a child's own `block` rule                — beats a global allow
 *   3. the global domain rules                   — block or allow
 *   4. category expansion, child then global
 *
 * A parent must be able to allow one site the platform blocks by category; that
 * is the whole reason an allow rule exists, and it is why the allow set is
 * subtracted at the end rather than merged in order.
 */
const { domainsForCategory } = require('../config/contentCategories');
const { normalizeDomain } = require('./domain');

/** The shape stored in the `contentFiltering` SystemSetting. */
const EMPTY_POLICY = { categories: [], domainRules: [] };

/**
 * A stored policy, with anything malformed dropped. Settings are edited through
 * the console but the row is just JSON, so nothing here may assume its shape.
 */
const normalizePolicy = (raw) => {
  const categories = Array.isArray(raw?.categories)
    ? [...new Set(raw.categories.filter((c) => typeof c === 'string'))]
    : [];

  const seen = new Set();
  const domainRules = Array.isArray(raw?.domainRules)
    ? raw.domainRules.reduce((out, rule) => {
      const domain = normalizeDomain(rule?.domain);
      if (!domain || seen.has(domain)) return out;
      seen.add(domain);
      out.push({
        domain,
        action: rule?.action === 'allow' ? 'allow' : 'block',
        addedBy: typeof rule?.addedBy === 'string' ? rule.addedBy : null,
        addedAt: rule?.addedAt || null,
      });
      return out;
    }, [])
    : [];

  return { categories, domainRules };
};

/**
 * Every domain that should be blocked for one child, and why.
 *
 * @param {object} options
 * @param {object} options.policy     the platform-wide policy (already normalized)
 * @param {Array}  options.childRules the child's own `WebsiteRule` rows
 * @returns {Array<{ url: string, action: 'block', source: string, category: string|null }>}
 */
const resolveBlockedDomains = ({ policy = EMPTY_POLICY, childRules = [] } = {}) => {
  const blocked = new Map(); // domain -> { source, category }
  const allowed = new Set();

  const block = (domain, source, category = null) => {
    if (!domain) return;
    // First writer wins, and the callers below run most-specific-last, so a
    // later, more specific source is allowed to overwrite the reason.
    blocked.set(domain, { source, category });
  };

  // 4. Categories — global first, then the child's own.
  for (const key of policy.categories || []) {
    for (const domain of domainsForCategory(key)) block(domain, 'global_category', key);
  }
  for (const rule of childRules) {
    if (rule.action !== 'block' || rule.url) continue;
    for (const domain of domainsForCategory(rule.category)) block(domain, 'child_category', rule.category);
  }

  // 3. Global domain rules.
  for (const rule of policy.domainRules || []) {
    if (rule.action === 'allow') allowed.add(rule.domain);
    else block(rule.domain, 'global_domain');
  }

  // 2 & 1. The child's own domain rules, which override everything above. An
  // allow here also lifts a global allow being overridden by a global block.
  for (const rule of childRules) {
    const domain = rule.url ? normalizeDomain(rule.url) : null;
    if (!domain) continue;
    if (rule.action === 'allow') { allowed.add(domain); blocked.delete(domain); }
    else { block(domain, 'child_domain', rule.category || null); allowed.delete(domain); }
  }

  return [...blocked.entries()]
    .filter(([domain]) => !allowed.has(domain))
    .map(([url, meta]) => ({ url, action: 'block', ...meta }));
};

/**
 * The `websiteRules` a device receives: its own rows, plus one synthetic row per
 * domain the categories and the platform policy add.
 *
 * The child's real rows are passed through untouched — the family app reads the
 * same endpoint through the parent API and the ids have to stay stable — and the
 * expanded entries are marked `derived: true` so nothing mistakes one for a row
 * it could delete.
 */
const deviceWebsiteRules = ({ policy, childRules = [] }) => {
  const own = childRules.filter((r) => r.url);
  const ownDomains = new Set(own.map((r) => normalizeDomain(r.url)).filter(Boolean));

  const derived = resolveBlockedDomains({ policy, childRules })
    .filter((entry) => !ownDomains.has(entry.url))
    .map((entry) => ({
      id: `derived:${entry.source}:${entry.url}`,
      url: entry.url,
      category: entry.category || 'derived',
      action: 'block',
      derived: true,
      source: entry.source,
    }));

  // The child's own rows first: a device that truncates or de-duplicates should
  // keep what the parent typed in preference to what a category implied.
  return [...own.map((r) => (typeof r.toJSON === 'function' ? r.toJSON() : r)), ...derived];
};

module.exports = { EMPTY_POLICY, normalizePolicy, resolveBlockedDomains, deviceWebsiteRules };

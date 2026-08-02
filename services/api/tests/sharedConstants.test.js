/**
 * Guards the two places where the API and the web apps have to agree but
 * cannot share a module: the API is CommonJS and lives outside the npm
 * workspace, so `packages/shared/src/constants.js` restates its roles,
 * permissions and alert labels by hand.
 *
 * Both files say "change both together" in their headers. This is what makes
 * that instruction enforceable, because the failure is silent: nothing throws
 * when they diverge, the console simply shows a parent `emergency_button`
 * where it meant to say "Emergency Alert", or a permission checkbox the API
 * does not honour.
 *
 * The shared file is ESM and this suite is CommonJS, so it is read as text and
 * parsed rather than imported. That is deliberate — a build step to make it
 * importable would be a lot of machinery for three regexes.
 */
const fs = require('node:fs');
const path = require('node:path');

const roles = require('../src/config/roles');

const SHARED = path.join(__dirname, '../../../packages/shared/src/constants.js');
const API_SRC = path.join(__dirname, '../src');

const sharedSource = fs.readFileSync(SHARED, 'utf8');

/** Reads one `export const NAME = { key: 'value', … }` object as a Map. */
const sharedObject = (name) => {
  const start = sharedSource.indexOf(`export const ${name}`);
  if (start === -1) throw new Error(`${name} is not exported from constants.js`);

  // First `};` after the declaration — works for both the multi-line objects
  // and the single-line ones like PLANS.
  const body = sharedSource.slice(start, sharedSource.indexOf('};', start));
  return new Map([...body.matchAll(/^\s{2}\[?([A-Za-z0-9_.]+)\]?:\s*'([^']*)'/gm)].map((m) => [m[1], m[2]]));
};

/** Reads one `export const NAME = ['a', 'b']`-style array of string literals. */
const sharedArrayLiterals = (name) => {
  const start = sharedSource.indexOf(`export const ${name}`);
  if (start === -1) throw new Error(`${name} is not exported from constants.js`);
  // First `};` after the declaration — works for both the multi-line objects
  // and the single-line ones like PLANS.
  const body = sharedSource.slice(start, sharedSource.indexOf('};', start));
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
};

/** Every source file under services/api/src. */
const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
};

describe('alert labels stay in step with the alerts the API emits', () => {
  // Every `createAlert(..., type: 'x', ...)` in the API. These are the values
  // that reach the Alerts page, and each one needs a human label there.
  const emittedTypes = [
    ...new Set(
      walk(API_SRC)
        .flatMap((file) => [...fs.readFileSync(file, 'utf8').matchAll(/createAlert\([\s\S]{0,400}?type:\s*'([a-z_]+)'/g)])
        .map((m) => m[1])
    ),
  ].sort();

  it('finds the alert types in the API source', () => {
    // A guard on the guard: if this regex ever stops matching, the test below
    // would pass vacuously against an empty list.
    expect(emittedTypes.length).toBeGreaterThanOrEqual(8);
    expect(emittedTypes).toContain('emergency_button');
  });

  it('has a label for every emitted alert type', () => {
    const labels = sharedObject('ALERT_LABELS');
    const unlabelled = emittedTypes.filter((type) => !labels.has(type));

    expect(unlabelled).toEqual([]);
  });
});

describe('roles and permissions stay in step with the API', () => {
  it('defines the same staff roles', () => {
    const shared = sharedObject('ROLES');
    const sharedStaff = [...shared.values()].filter((role) => role !== roles.PARENT_ROLE);

    expect(sharedStaff.sort()).toEqual([...roles.STAFF_ROLES].sort());
  });

  it('defines the same permissions', () => {
    const shared = sharedObject('PERMISSIONS');

    expect([...shared.values()].sort()).toEqual([...roles.PERMISSION_KEYS].sort());
  });

  it('labels every staff role', () => {
    const labels = sharedObject('ROLE_LABELS');

    for (const role of roles.STAFF_ROLES) {
      expect(labels.get(`ROLES.${Object.keys(roles.ROLES).find((k) => roles.ROLES[k] === role)}`)).toBe(
        roles.ROLE_LABELS[role]
      );
    }
  });

  it('grants each role the same default permissions the API does', () => {
    // The shared file builds these from PERMISSIONS.* references rather than
    // string literals, so compare against the API by resolving those names.
    const byName = Object.fromEntries(Object.entries(roles.PERMISSIONS).map(([k, v]) => [`PERMISSIONS.${k}`, v]));
    const start = sharedSource.indexOf('export const ROLE_PERMISSIONS');
    // First `};` after the declaration — works for both the multi-line objects
  // and the single-line ones like PLANS.
  const body = sharedSource.slice(start, sharedSource.indexOf('};', start));

    for (const [roleKey, expected] of Object.entries(roles.ROLE_PERMISSIONS)) {
      const name = Object.keys(roles.ROLES).find((k) => roles.ROLES[k] === roleKey);
      const marker = `[ROLES.${name}]`;

      // Slice the role's array only: start at the '[' that opens it, which is
      // after the one closing `[ROLES.NAME]`, and end at its matching ']'.
      const after = body.slice(body.indexOf(marker) + marker.length);
      const open = after.indexOf('[');
      const arrayBody = after.slice(open, after.indexOf(']', open));

      // SUPER_ADMIN spreads every key rather than listing them.
      if (arrayBody.includes('...PERMISSION_KEYS')) {
        expect(new Set(expected)).toEqual(new Set(roles.PERMISSION_KEYS));
        continue;
      }

      const listed = [...arrayBody.matchAll(/PERMISSIONS\.[A-Z_]+/g)].map((m) => byName[m[0]]);

      expect(listed.filter(Boolean)).toHaveLength(listed.length); // every name resolved
      expect(new Set(listed)).toEqual(new Set(expected));
    }
  });

  it('lists the same plans the API gates on', () => {
    const plans = sharedArrayLiterals('PLANS');

    expect(plans.sort()).toEqual(['family', 'free', 'premium']);
  });
});

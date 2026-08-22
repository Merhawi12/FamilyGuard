/**
 * The alert catalogue has to describe the product, not the ambition.
 *
 * `config/alertTypes.js` is what the console's Overview presents as "the
 * platform's alert rules", and its own header promises that each row names a
 * real producer in the source. Three of them did not: `unknown_contact`,
 * `app_installed` and `dangerous_content` all had a socket handler listening for
 * an event no device has ever sent.
 *
 * The cost was not cosmetic. The family app drew an "Unapproved contact" switch
 * that offered to turn off an alert never once raised, the Contacts page told
 * parents an alert would follow when they blocked someone, and an operator could
 * mute a rule that could not fire.
 *
 * Two were built and one was refused, and this suite pins all three outcomes so
 * none of them quietly reverts to a promise. What makes it a real check rather
 * than a second list to keep in step is that it reads the child app's actual
 * `emitEvent('alert:…')` calls: a catalogue row naming the device as its
 * producer has to correspond to something the device really sends.
 */
const fs = require('node:fs');
const path = require('node:path');
const {
  ALERT_TYPES, ALERT_TYPE_KEYS, RAISEABLE_ALERT_TYPE_KEYS,
} = require('../src/config/alertTypes');

const REPO = path.join(__dirname, '../../..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

/** Every `emitEvent('alert:x')` the child app really performs. */
const childEmitted = () => {
  const dir = path.join(REPO, 'apps/child-app/shared/src');
  const files = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.jsx?$/.test(entry.name)) files.push(full);
    }
  };
  walk(dir);

  return new Set(
    files
      .flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/emit(?:Event|Socket)\(\s*'alert:([a-z_]+)'/g)])
      .map((m) => m[1]),
  );
};

/**
 * The device's vocabulary is not the API's: it emits `alert:blocked_app` and
 * the server records that as `blocked_app_attempt`, and `screen_time_exceeded`
 * is spelled the same on both sides. Only the names that differ are listed.
 */
const SERVER_TYPE_FOR = { blocked_app: 'blocked_app_attempt' };

describe('the alert catalogue', () => {
  it('marks a type as raiseable only when a producer is named', () => {
    for (const type of ALERT_TYPES) {
      expect(RAISEABLE_ALERT_TYPE_KEYS.includes(type.key)).toBe(!!type.producer);
    }
  });

  /**
   * The two that were built rather than dropped.
   *
   * Both had a socket handler waiting on an event the device never sent.
   * `dangerous_content` is now raised by the API from the domains the phone
   * already reports, and `app_installed` by the device from the usage sync it
   * already runs — neither needed the mechanism the catalogue had assumed, and
   * both are labelled for what they actually detect rather than for that
   * mechanism.
   */
  it('raises the two types that used to be listed and never fired', () => {
    for (const key of ['dangerous_content', 'app_installed']) {
      expect(RAISEABLE_ALERT_TYPE_KEYS).toContain(key);
    }
  });

  /**
   * And the one that was removed instead.
   *
   * Matching a caller against the parent's approved list needs READ_CALL_LOG,
   * and a text needs RECEIVE_SMS — both Play-restricted, both refused on this
   * product. Leaving the key behind would keep the capability looking imminent
   * on every screen that reads this table, so the decision is recorded by its
   * absence and pinned here.
   */
  it('no longer carries a type the product has decided not to build', () => {
    expect(ALERT_TYPE_KEYS).not.toContain('unknown_contact');
  });

  /**
   * The check that would have caught this in the first place: an alert type
   * whose producer is the child device must correspond to something the child
   * app actually emits.
   */
  it('does not claim a device producer the child app has no emitter for', () => {
    const emitted = new Set([...childEmitted()].map((name) => SERVER_TYPE_FOR[name] || name));

    const lying = ALERT_TYPES
      .filter((type) => type.producer === 'sockets/deviceEvents.js')
      // `emergency_button` and `cyberbullying` are raised by the server from the
      // *content* of a chat message, not by an `alert:` emit, so they are the
      // two device-originated types with no emitter of their own.
      .filter((type) => !['emergency_button', 'cyberbullying'].includes(type.key))
      .filter((type) => !emitted.has(type.key))
      .map((type) => type.key);

    expect(lying).toEqual([]);
  });

  it('offers the parent a switch for exactly the alerts that can reach them', () => {
    // A preference for an alert that cannot be raised is a control over nothing;
    // one missing for an alert that can is a notification a parent cannot stop.
    const settings = read('apps/family-app/src/pages/Settings.jsx');
    const block = settings.slice(settings.indexOf('const ALERT_TYPES = ['));
    const offered = [...block.slice(0, block.indexOf('];')).matchAll(/key:\s*'([a-z_]+)'/g)].map((m) => m[1]);

    expect(offered.sort()).toEqual([...RAISEABLE_ALERT_TYPE_KEYS].sort());
  });
});

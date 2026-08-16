/**
 * Every alert the platform can raise, and what raises it.
 *
 * The console's Overview lists these as the platform's alert rules. They are not
 * rules an operator writes — each one names a real producer in the source, and
 * the `condition` below is that producer described in words rather than a
 * threshold anybody could edit. Inventing an editable "CPU > 90% for 5m" would
 * have meant a row that governed nothing; what *is* editable is delivery, which
 * is why each type can be muted (see `utils/alertDelivery.js`).
 *
 * `severity` is the value the producer passes to `createAlert`, not a wish: a
 * mismatch between this table and the call is caught by `sharedConstants.test.js`,
 * which reads the emitted types straight out of the API source.
 *
 * ── `producer: null` ─────────────────────────────────────────────────────────
 * Three entries here claimed `sockets/deviceEvents.js` and were not true: the
 * handlers existed, nothing on the device had ever emitted to them. Each was
 * resolved rather than left as a promise, and the three answers were different.
 *
 *   - `dangerous_content` **was built**, from a signal the platform already had.
 *     Classifying a page needs to see the page; the phone sees DNS names — but
 *     `contentCategories.js` already maps a domain to a category, so a lookup of
 *     an adult or gambling site is a fact the API was throwing away. See
 *     `utils/riskyBrowsing.js`. Relabelled for what it detects.
 *
 *   - `app_installed` **was built**, without the receiver it assumed. The usage
 *     sync already reports every package a child opens, so the device remembers
 *     the set and announces what is new — which is the more useful question
 *     anyway: an app installed and never opened wakes nobody up. See the child
 *     app's `services/newApps.js`. Relabelled likewise.
 *
 *   - `unknown_contact` **was removed.** Matching a caller against the parent's
 *     approved list needs the number, and on Android 9+ that means READ_CALL_LOG
 *     (RECEIVE_SMS for texts) — both on Google Play's restricted list, both
 *     needing a declared and reviewed use case, on a product that has kept its
 *     permissions narrow enough to explain to a family. Parentix is not going to
 *     ask for a child's call log, so the type, its handler and the device's dead
 *     matching code are gone. The approved list itself stays: it is the parent's
 *     record of who is in their child's life, and the child app now shows it to
 *     the child.
 *
 * `producer: null` remains the way to say "listed, not raised" — the console
 * greys such a row and disables its mute switch, and the family app leaves it out
 * of the per-type preferences. Today nothing is in that state, and
 * `alertCatalogue.test.js` is what keeps a named producer honest.
 */

const ALERT_TYPES = [
  {
    key: 'emergency_button',
    label: 'Emergency alert',
    condition: 'A child sends an emergency message from their device',
    severity: 'high',
    producer: 'sockets/deviceEvents.js',
  },
  {
    key: 'cyberbullying',
    label: 'Cyberbullying detected',
    condition: 'A message matches the cyberbullying detector',
    severity: 'high',
    producer: 'utils/cyberbullyingDetector.js',
  },
  {
    key: 'safety_pattern',
    label: 'Safety pattern detected',
    condition: 'The hourly safety analysis flags a pattern in recent activity',
    severity: 'high',
    producer: 'utils/safetyAnalyzer.js',
  },
  {
    key: 'screen_time_exceeded',
    label: 'Screen time exceeded',
    condition: 'A device reaches its daily limit, bedtime or schedule lock',
    severity: 'high',
    producer: 'sockets/deviceEvents.js',
  },
  {
    key: 'left_safe_zone',
    label: 'Left safe zone',
    condition: 'A device crosses out of a safe zone the parent drew',
    severity: 'high',
    producer: 'controllers/locationController.js',
  },
  {
    key: 'entered_safe_zone',
    label: 'Arrived at safe zone',
    condition: 'A device crosses into a safe zone the parent drew',
    severity: 'medium',
    producer: 'controllers/locationController.js',
  },
  {
    key: 'blocked_app_attempt',
    label: 'Blocked app attempt',
    condition: 'A blocked app is opened on a child device',
    severity: 'medium',
    producer: 'sockets/deviceEvents.js',
  },
  {
    key: 'dangerous_content',
    label: 'Risky site opened',
    condition: 'A device resolves a domain in the adult or gambling category',
    severity: 'high',
    producer: 'utils/riskyBrowsing.js',
  },
  {
    key: 'app_installed',
    label: 'New app used',
    condition: 'A child opens an app this device has not seen them open before',
    severity: 'medium',
    producer: 'sockets/deviceEvents.js',
  },
];

const ALERT_TYPE_KEYS = ALERT_TYPES.map((t) => t.key);

/**
 * The types something in the product actually raises.
 *
 * Derived rather than listed a second time, so a producer that is wired up (or
 * removed) changes one field and every surface follows.
 */
const RAISEABLE_ALERT_TYPES = ALERT_TYPES.filter((t) => t.producer);
const RAISEABLE_ALERT_TYPE_KEYS = RAISEABLE_ALERT_TYPES.map((t) => t.key);

module.exports = {
  ALERT_TYPES,
  ALERT_TYPE_KEYS,
  RAISEABLE_ALERT_TYPES,
  RAISEABLE_ALERT_TYPE_KEYS,
};

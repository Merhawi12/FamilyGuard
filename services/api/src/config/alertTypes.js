/**
 * Every alert the platform can raise, and what raises it.
 *
 * The console's Overview lists these as the platform's alert rules. They are not
 * rules an operator writes — each one is a real producer in the source, and the
 * `condition` below is that producer described in words rather than a threshold
 * anybody could edit. Inventing an editable "CPU > 90% for 5m" would have meant a
 * row that governed nothing; what *is* editable is delivery, which is why each
 * type can be muted (see `utils/alertDelivery.js`).
 *
 * `severity` is the value the producer passes to `createAlert`, not a wish: a
 * mismatch between this table and the call is caught by `sharedConstants.test.js`,
 * which reads the emitted types straight out of the API source.
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
    key: 'unknown_contact',
    label: 'Unknown contact',
    condition: 'Someone not on the approved list reaches the child',
    severity: 'high',
    producer: 'sockets/deviceEvents.js',
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
    label: 'Dangerous content detected',
    condition: 'A device reports content it classified as dangerous',
    severity: 'high',
    producer: 'sockets/deviceEvents.js',
  },
  {
    key: 'app_installed',
    label: 'New app installed',
    condition: 'A device reports an app it has not seen before',
    severity: 'medium',
    producer: 'sockets/deviceEvents.js',
  },
];

const ALERT_TYPE_KEYS = ALERT_TYPES.map((t) => t.key);

module.exports = { ALERT_TYPES, ALERT_TYPE_KEYS };

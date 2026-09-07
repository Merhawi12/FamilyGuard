/**
 * The hourly safety pass, and the one property it depends on: raising each
 * pattern **once** per child per day.
 *
 * There was no coverage here, which is how two of its three dedupe checks came
 * to search for words that do not appear in the messages they guard —
 * `'%late night%'` against "used devices late at night", and `'%excessive%'`
 * against "unusually high". `createAlert` does not deduplicate, so neither check
 * ever suppressed anything: a child over the five-hour limit at 18:00 raised a
 * fresh alert on every pass until midnight, and each one sent the parent an
 * email and a push. Six notifications about one afternoon, from a job whose own
 * header says duplicate runs are harmless.
 *
 * So the tests that matter here are the second-run ones.
 */
const { ActivityLog, Alert } = require('../src/models');
const { analyzeParent, PATTERN_TEXT } = require('../src/utils/safetyAnalyzer');
const { createUser, createChild, createDevice } = require('./helpers');

jest.mock('../src/utils/email', () => ({ sendAlertEmail: jest.fn(async () => true) }));
jest.mock('../src/utils/pushService', () => ({ sendToUser: jest.fn(async () => {}) }));
const { sendAlertEmail } = require('../src/utils/email');

const io = { to: () => ({ emit: () => {} }) };

let parent;
let child;
let device;

beforeEach(async () => {
  sendAlertEmail.mockClear();
  parent = await createUser();
  child = await createChild(parent.id);
  device = await createDevice(child.id);
});

/** Screen time recorded today, at a given hour of this machine's local day. */
const logUsage = async (minutes, hour = 12) => {
  const at = new Date();
  at.setHours(hour, 0, 0, 0);
  return ActivityLog.create({
    deviceId: device.id,
    childId: child.id,
    appName: 'TikTok',
    appPackage: 'com.tiktok',
    category: 'app_usage',
    startTime: at,
    endTime: at,
    durationMinutes: minutes,
  });
};

const patternAlerts = () =>
  Alert.findAll({ where: { parentId: parent.id, childId: child.id, type: 'safety_pattern' } });

describe('safety analysis raises each pattern once a day', () => {
  it('raises excessive usage, then stays quiet on the next pass', async () => {
    await logUsage(360); // six hours, over EXCESSIVE_MINUTES

    await analyzeParent(io, parent.id);
    expect(await patternAlerts()).toHaveLength(1);

    // The pass that used to duplicate: the condition still holds an hour later.
    await analyzeParent(io, parent.id);
    expect(await patternAlerts()).toHaveLength(1);
    expect(sendAlertEmail).toHaveBeenCalledTimes(1);
  });

  it('raises late-night usage, then stays quiet on the next pass', async () => {
    await logUsage(45, 23);

    await analyzeParent(io, parent.id);
    const first = await patternAlerts();
    expect(first.some((a) => a.message.includes(PATTERN_TEXT.lateNight))).toBe(true);
    const count = first.length;

    await analyzeParent(io, parent.id);
    expect(await patternAlerts()).toHaveLength(count);
  });

  it('raises nothing for a quiet day', async () => {
    await logUsage(20);
    await analyzeParent(io, parent.id);
    expect(await patternAlerts()).toHaveLength(0);
    expect(sendAlertEmail).not.toHaveBeenCalled();
  });

  /**
   * The check that would have caught the original bug outright, and the reason
   * `PATTERN_TEXT` is exported: a dedupe fragment is only a dedupe if it appears
   * in the message it is matched against.
   */
  it('deduplicates on text the messages actually contain', async () => {
    await logUsage(360, 23);
    await analyzeParent(io, parent.id);

    const alerts = await patternAlerts();
    expect(alerts.length).toBeGreaterThan(0);

    for (const alert of alerts) {
      const matched = Object.values(PATTERN_TEXT).filter((text) => alert.message.includes(text));
      // Exactly one: a message matching two fragments would let one pattern
      // suppress another's alert for the rest of the day.
      expect(matched).toHaveLength(1);
    }
  });

  it('leaves another family alone', async () => {
    await logUsage(360);
    const other = await createUser();

    await analyzeParent(io, other.id);
    expect(await patternAlerts()).toHaveLength(0);
  });
});

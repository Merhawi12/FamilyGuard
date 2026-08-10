import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import AppShell from '../components/AppShell';
import Icon from '../components/Icon';
import ProgressRing from '../components/ProgressRing';
import { Card, Pill } from '../components/ui';
import { loadChildName } from '../services/profile';
import { startMonitoring, getMonitoringStatus } from '../services/monitoring';
import { lockState } from '../services/schedule';
import { colors, space, type } from '../theme';

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** 135 → "2h 15m". Whole hours drop the minutes; under an hour drops the hours. */
function formatDuration(minutes) {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** The schedule arrives parsed, but a device that has never synced holds JSON. */
function todayWindow(rule) {
  let schedule = rule?.schedule;
  if (typeof schedule === 'string') {
    try { schedule = JSON.parse(schedule); } catch { schedule = null; }
  }
  const today = schedule?.[DAY_KEYS[new Date().getDay()]];
  return today?.enabled ? `${today.start} – ${today.end}` : null;
}

/**
 * My Day — what the child actually needs to know: how much time is left, when
 * the phone stops, and what is paused right now.
 *
 * Everything on this screen comes from the parent's rules and this device's own
 * usage. The detail — which apps, which sites, what is being monitored — lives
 * on Settings, one tap away, so the first screen is an answer rather than a
 * report.
 */
export default function HomeScreen({ navigation }) {
  const [rules, setRules] = useState({ appRules: [], websiteRules: [], screenTimeRule: null });
  const [blockedPackages, setBlockedPackages] = useState([]);
  const [todayMinutes, setTodayMinutes] = useState(0);
  const [childName, setChildName] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const appState = useRef(AppState.currentState);

  const refresh = useCallback(async () => {
    const monitoring = getMonitoringStatus();
    setRules(monitoring.rules);
    setBlockedPackages(monitoring.blockedPackages || []);
    setTodayMinutes(monitoring.todayMinutes);
    setChildName(await loadChildName());
  }, []);

  const pullToRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  useEffect(() => {
    startMonitoring().then(refresh);

    // Permissions and usage both change while the child is in Android Settings,
    // so the numbers are re-read on the way back rather than left stale.
    const subscription = AppState.addEventListener('change', (next) => {
      if (appState.current.match(/inactive|background/) && next === 'active') refresh();
      appState.current = next;
    });
    const interval = setInterval(refresh, 30_000);

    return () => {
      subscription.remove();
      clearInterval(interval);
    };
  }, [refresh]);

  const rule = rules.screenTimeRule;
  const limit = rule?.dailyLimitMinutes || null;
  const used = Math.round(todayMinutes);
  const remaining = limit ? Math.max(limit - used, 0) : null;
  const progress = limit ? Math.min(used / limit, 1) : 0;

  const lock = lockState(rule, todayMinutes);
  /**
   * What the blocker is actually enforcing, not what the rules could imply.
   *
   * Filtering the rules for `action === 'block'` answered a different question
   * and got it wrong both ways once time limits existed: an app with a limit it
   * has not reached is not paused, and one that has reached it is — and neither
   * appeared here. `'*'` is the whole-device lock, which the message above
   * already explains, so it is not counted as an app.
   */
  const pausedApps = blockedPackages.filter((p) => p !== '*');
  const blockedSites = rules.websiteRules.filter((r) => r.action === 'block');
  const window = todayWindow(rule);

  const ringColor = lock.blocked ? colors.danger
    : progress > 0.8 ? colors.warning
      : colors.teal500;

  const message = lock.reason === 'daily_limit' ? "That's all your screen time for today."
    : lock.reason === 'bedtime' ? "It's bedtime — see you in the morning."
      : lock.reason === 'outside_schedule' ? 'Your phone is having a rest right now.'
        : remaining !== null && remaining <= 15 ? 'Nearly out of time — make it count!'
          : limit ? "You're doing great today." : 'No time limit today. Have fun.';

  return (
    <AppShell route="Home" navigation={navigation} refreshing={refreshing} onRefresh={pullToRefresh}>
      <Card tone="teal" style={styles.hero}>
        <View style={styles.heroAvatar}>
          <Icon name="sparkle" size={22} color={colors.white} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.heroGreeting} numberOfLines={1}>
            Hi{childName ? `, ${childName}` : ' there'}! 👋
          </Text>
          <Text style={styles.heroMessage}>{message}</Text>
        </View>
      </Card>

      <Card style={{ alignItems: 'center' }}>
        <Text style={[type.section, { textAlign: 'center' }]}>Today&apos;s Time</Text>
        <Text style={[type.caption, { marginTop: 2, marginBottom: space.lg }]}>Make it count!</Text>

        <ProgressRing progress={progress} color={ringColor}>
          <View style={styles.ringCentre}>
            <Text style={[styles.ringValue, { color: ringColor }]}>
              {remaining !== null ? formatDuration(remaining) : formatDuration(used)}
            </Text>
            <Text style={styles.ringLabel}>{remaining !== null ? 'LEFT' : 'USED TODAY'}</Text>
          </View>
        </ProgressRing>

        <Pill
          style={{ marginTop: space.lg }}
          icon="time"
          tone={lock.blocked ? 'danger' : 'teal'}
          label={limit ? `Total limit: ${formatDuration(limit)}` : 'No daily limit set'}
        />
        {limit !== null && (
          <Text style={[type.caption, { marginTop: space.sm }]}>
            {formatDuration(used)} used so far
          </Text>
        )}
      </Card>

      <View style={styles.pair}>
        <Card style={styles.pairCard}>
          <View style={[styles.pairIcon, { backgroundColor: colors.teal50 }]}>
            <Icon name="bedtime" size={20} color={colors.teal700} />
          </View>
          <Text style={styles.pairValue}>
            {rule?.bedtimeEnabled ? `${rule.bedtimeStart} – ${rule.bedtimeEnd}` : 'Off'}
          </Text>
          <Text style={type.caption}>Bedtime</Text>
        </Card>

        <Card style={styles.pairCard}>
          <View style={[styles.pairIcon, { backgroundColor: colors.teal50 }]}>
            <Icon name="calendar" size={20} color={colors.teal700} />
          </View>
          <Text style={styles.pairValue}>{window || 'All day'}</Text>
          <Text style={type.caption}>Today&apos;s hours</Text>
        </Card>
      </View>

      <TouchableOpacity
        activeOpacity={0.85}
        onPress={() => navigation.navigate('Settings')}
        accessibilityRole="button"
        accessibilityLabel="See what is paused right now"
      >
        <Card style={styles.linkCard}>
          <View style={[styles.pairIcon, { backgroundColor: colors.teal50, marginBottom: 0 }]}>
            <Icon name="blocked" size={20} color={colors.teal700} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={type.section}>Paused right now</Text>
            <Text style={[type.small, { marginTop: 2 }]}>
              {lock.blocked
                ? 'Every app is paused right now.'
                : pausedApps.length + blockedSites.length === 0
                  ? 'Nothing is blocked — everything is open.'
                  : `${pausedApps.length} app${pausedApps.length === 1 ? '' : 's'} · `
                    + `${blockedSites.length} site${blockedSites.length === 1 ? '' : 's'}`}
            </Text>
          </View>
          <Icon name="forward" size={18} color={colors.muted} />
        </Card>
      </TouchableOpacity>

      <TouchableOpacity
        activeOpacity={0.85}
        onPress={() => navigation.navigate('Messages')}
        accessibilityRole="button"
        accessibilityLabel="Ask your parent for more time"
      >
        <Card tone="teal" style={styles.askCard}>
          <View style={styles.askIcon}>
            <Icon name="messages" size={20} color={colors.teal700} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.askTitle}>Need more time?</Text>
            <Text style={styles.askText}>Send your parent a message and ask.</Text>
          </View>
          <Icon name="forward" size={18} color={colors.teal200} />
        </Card>
      </TouchableOpacity>
    </AppShell>
  );
}

const styles = StyleSheet.create({
  hero: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  heroAvatar: {
    width: 46, height: 46, borderRadius: 23,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
  },
  heroGreeting: { fontSize: 17, fontWeight: '800', color: colors.white },
  heroMessage: { fontSize: 13.5, fontWeight: '500', color: colors.teal100, marginTop: 3 },

  ringCentre: { alignItems: 'center', justifyContent: 'center' },
  ringValue: { fontSize: 30, fontWeight: '800', letterSpacing: -0.5 },
  ringLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 1.4, color: colors.muted, marginTop: 2 },

  pair: { flexDirection: 'row', gap: space.md },
  pairCard: { flex: 1, alignItems: 'flex-start', gap: 2 },
  pairIcon: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center', marginBottom: space.sm,
  },
  pairValue: { fontSize: 15, fontWeight: '800', color: colors.ink },

  linkCard: { flexDirection: 'row', alignItems: 'center', gap: space.md },

  askCard: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  askIcon: {
    width: 38, height: 38, borderRadius: 19, backgroundColor: colors.white,
    alignItems: 'center', justifyContent: 'center',
  },
  askTitle: { fontSize: 15.5, fontWeight: '800', color: colors.white },
  askText: { fontSize: 13, fontWeight: '500', color: colors.teal100, marginTop: 2 },
});

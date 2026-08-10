import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import AppShell from '../components/AppShell';
import Icon from '../components/Icon';
import { Button, Card, EmptyNote, Pill, Row, SectionTitle } from '../components/ui';
import { getDeviceId } from '../services/link';
import { getMonitoringStatus } from '../services/monitoring';
import { colors, radius, space, type } from '../theme';

/**
 * What this phone is doing, and what the parent has paused.
 *
 * This used to be the home screen. It is honest and it is dull — exactly the
 * wrong first impression for a child, and exactly the right thing to keep one
 * tap away. Nothing here is hidden or summarised away: every monitor and every
 * blocked app and site is listed, because a child is entitled to know what is
 * being recorded about them.
 */
const MONITORS = [
  { key: 'monitoring', label: 'Monitoring is running', icon: 'shieldOutline' },
  { key: 'appBlocking', label: 'App blocking', icon: 'apps' },
  { key: 'websiteBlocking', label: 'Website blocking', icon: 'globe' },
  { key: 'webHistory', label: 'Web history', icon: 'usage' },
  { key: 'locationTracking', label: 'Location', icon: 'location' },
  { key: 'contactSync', label: 'Approved contacts', icon: 'phone' },
  { key: 'pushNotifications', label: 'Notifications', icon: 'bell' },
];

/** "2026-08-09T14:03:00Z" → "14:03" today, "9 Aug" before that. */
function lastSyncLabel(iso) {
  if (!iso) return 'Not yet';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'Not yet';
  const sameDay = at.toDateString() === new Date().toDateString();
  return sameDay
    ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : at.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export default function SettingsScreen({ navigation }) {
  const [status, setStatus] = useState({});
  const [rules, setRules] = useState({ appRules: [], websiteRules: [], screenTimeRule: null });
  const [sync, setSync] = useState({ lastSyncAt: null, lastError: null });
  const [deviceId, setDeviceId] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const appState = useRef(AppState.currentState);

  const refresh = useCallback(() => {
    const monitoring = getMonitoringStatus();
    setStatus(monitoring.status);
    setRules(monitoring.rules);
    setSync(monitoring.sync || { lastSyncAt: null, lastError: null });
  }, []);

  const pullToRefresh = useCallback(async () => {
    setRefreshing(true);
    refresh();
    setRefreshing(false);
  }, [refresh]);

  useEffect(() => {
    getDeviceId().catch(() => null).then(setDeviceId);
    refresh();

    // A permission granted in Android Settings only shows up here on the way
    // back, so the status is re-read rather than left as it was on the way out.
    const subscription = AppState.addEventListener('change', (next) => {
      if (appState.current.match(/inactive|background/) && next === 'active') refresh();
      appState.current = next;
    });
    return () => subscription.remove();
  }, [refresh]);

  /**
   * Both kinds of app rule, not just the outright block.
   *
   * A time limit is a rule about this phone exactly as much as a block is, and
   * filtering to `action === 'block'` meant a child with a 45-minute cap on one
   * app was shown "Nothing is blocked. Every app and website on this phone is
   * open right now" — and then found the app closed on them at some point in the
   * afternoon with no explanation anywhere. This screen exists so that does not
   * happen.
   */
  const ruledApps = rules.appRules.filter((r) => r.action === 'block' || r.action === 'limit');
  const blockedSites = rules.websiteRules.filter((r) => r.action === 'block');
  const off = MONITORS.filter((m) => !status[m.key]);

  return (
    <AppShell route="Settings" navigation={navigation} refreshing={refreshing} onRefresh={pullToRefresh}>
      <Card>
        <SectionTitle hint="What this phone shares with your parent.">On this device</SectionTitle>

        {MONITORS.map((monitor, i) => (
          <Row
            key={monitor.key}
            icon={monitor.icon}
            label={monitor.label}
            value={status[monitor.key] ? 'On' : 'Off'}
            tone={status[monitor.key] ? 'success' : 'muted'}
            last={i === MONITORS.length - 1}
          />
        ))}

        {off.length > 0 && (
          <View style={styles.notice}>
            <Icon name="warningOutline" size={18} color={colors.warning} />
            <Text style={[type.small, { flex: 1, color: colors.ink }]}>
              {off.length} thing{off.length === 1 ? ' is' : 's are'} switched off. Your parent may ask you
              to turn {off.length === 1 ? 'it' : 'them'} back on.
            </Text>
          </View>
        )}

        <Button
          title="Check permissions"
          icon="key"
          kind="secondary"
          style={{ marginTop: space.lg }}
          onPress={() => navigation.navigate('Permissions')}
        />
      </Card>

      <Card>
        <SectionTitle hint="Set by your parent — you cannot change these here.">
          Paused apps and sites
        </SectionTitle>

        {ruledApps.length === 0 && blockedSites.length === 0 ? (
          <EmptyNote
            icon="heart"
            title="Nothing is blocked"
            text="Every app and website on this phone is open right now."
          />
        ) : (
          <>
            {ruledApps.length > 0 && (
              <View style={{ marginBottom: blockedSites.length ? space.lg : 0 }}>
                <Text style={styles.groupLabel}>APPS ({ruledApps.length})</Text>
                {ruledApps.map((rule, i) => (
                  <Row
                    key={rule.id}
                    icon="apps"
                    label={rule.appName || rule.appPackage}
                    // A cap says what it is. "Paused" for an app that still opens
                    // for another twenty minutes would be the same wrong answer
                    // in the other direction.
                    value={rule.action === 'limit' && rule.dailyLimitMinutes
                      ? `${rule.dailyLimitMinutes} min/day`
                      : 'Paused'}
                    tone={rule.action === 'limit' ? 'warning' : 'danger'}
                    last={i === ruledApps.length - 1}
                  />
                ))}
              </View>
            )}

            {blockedSites.length > 0 && (
              <View>
                <Text style={styles.groupLabel}>WEBSITES ({blockedSites.length})</Text>
                {blockedSites.map((rule, i) => (
                  <Row
                    key={rule.id}
                    icon="globe"
                    label={rule.url || rule.category}
                    value="Blocked"
                    tone="danger"
                    last={i === blockedSites.length - 1}
                  />
                ))}
              </View>
            )}
          </>
        )}
      </Card>

      {/*
        The link, as it actually is.

        This card used to draw a green "Linked" pill unconditionally, from no
        source at all — so a phone whose account had been suspended, or one that
        had not reached the server in a week, said exactly what a healthy one
        said. A device that has genuinely been unlinked no longer reaches this
        screen (the app returns to linking), which leaves one honest question for
        this card to answer: when did the parent's settings last get through?
      */}
      <Card>
        <SectionTitle>This device</SectionTitle>
        <View style={styles.deviceRow}>
          <View style={styles.deviceIcon}>
            <Icon name="phone" size={20} color={colors.teal700} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={type.section}>Linked to your parent</Text>
            <Text style={[type.caption, { marginTop: 2 }]}>
              ID {deviceId ? deviceId.slice(0, 8) : '—'} · Last update {lastSyncLabel(sync.lastSyncAt)}
            </Text>
          </View>
          <Pill
            label={sync.lastError ? 'Offline' : 'Linked'}
            icon={sync.lastError ? 'warningOutline' : 'check'}
            tone={sync.lastError ? 'warning' : 'success'}
          />
        </View>
        {sync.lastError && (
          <View style={styles.notice}>
            <Icon name="warningOutline" size={18} color={colors.warning} />
            <Text style={[type.small, { flex: 1, color: colors.ink }]}>
              This phone cannot reach Parentix right now, so it is using the last settings it
              received. Check the internet connection.
            </Text>
          </View>
        )}
        <Text style={[type.caption, { marginTop: space.md }]}>
          Only your parent can unlink this phone, from their app.
        </Text>
      </Card>
    </AppShell>
  );
}

const styles = StyleSheet.create({
  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    backgroundColor: colors.warningSoft,
    borderRadius: radius.md,
    padding: space.md,
    marginTop: space.lg,
  },
  groupLabel: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.4,
    color: colors.muted,
    marginBottom: space.xs,
  },
  deviceRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  deviceIcon: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: colors.teal50,
    alignItems: 'center', justifyContent: 'center',
  },
});

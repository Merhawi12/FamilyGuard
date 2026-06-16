import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, AppState } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { startMonitoring, stopMonitoring, getMonitoringStatus } from '../services/monitoring';

export default function HomeScreen() {
  const [status, setStatus] = useState({
    monitoring: false,
    appBlocking: false,
    websiteBlocking: false,
    locationTracking: false,
  });
  const [rules, setRules] = useState({ appRules: [], websiteRules: [], screenTimeRule: null });
  const [todayMinutes, setTodayMinutes] = useState(0);
  const [deviceId, setDeviceId] = useState(null);
  const appState = useRef(AppState.currentState);

  const refresh = async () => {
    const mon = getMonitoringStatus();
    setStatus(mon.status);
    setRules(mon.rules);
    setTodayMinutes(mon.todayMinutes);
  };

  useEffect(() => {
    SecureStore.getItemAsync('fg_device_id').then(setDeviceId);

    startMonitoring().then(refresh);

    // Re-check permissions when the user returns from Settings
    const sub = AppState.addEventListener('change', (next) => {
      if (appState.current.match(/inactive|background/) && next === 'active') {
        refresh();
      }
      appState.current = next;
    });

    const interval = setInterval(refresh, 30_000);

    return () => {
      sub.remove();
      clearInterval(interval);
    };
  }, []);

  const screenTimeLimit = rules.screenTimeRule?.dailyLimitMinutes ?? null;
  const screenTimePct = screenTimeLimit ? Math.min((todayMinutes / screenTimeLimit) * 100, 100) : 0;
  const blockedApps = rules.appRules.filter((r) => r.action === 'block');
  const blockedSites = rules.websiteRules.filter((r) => r.action === 'block');

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>🛡️ FamilyGuard</Text>
      <Text style={styles.sub}>Device ID: {deviceId?.slice(0, 8) ?? '—'}...</Text>

      {/* Monitoring status */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Monitoring Status</Text>
        <StatusRow label="Active monitoring" on={status.monitoring} />
        <StatusRow label="App blocking" on={status.appBlocking} />
        <StatusRow label="Website blocking" on={status.websiteBlocking} />
        <StatusRow label="Location tracking" on={status.locationTracking} />
      </View>

      {/* Screen time */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Today's Screen Time</Text>
        <Text style={styles.bigNum}>{Math.round(todayMinutes)} min</Text>
        {screenTimeLimit && (
          <>
            <View style={styles.barTrack}>
              <View style={[styles.barFill, { width: `${screenTimePct}%`, backgroundColor: screenTimePct > 90 ? '#ef4444' : '#2563eb' }]} />
            </View>
            <Text style={styles.barLabel}>Limit: {screenTimeLimit} min/day</Text>
          </>
        )}
      </View>

      {/* Blocked apps */}
      {blockedApps.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Blocked Apps ({blockedApps.length})</Text>
          {blockedApps.map((r) => (
            <View key={r.id} style={styles.row}>
              <Text style={styles.rowLabel}>{r.appName || r.appPackage}</Text>
              <Text style={styles.badge}>Blocked</Text>
            </View>
          ))}
        </View>
      )}

      {/* Blocked websites */}
      {blockedSites.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Blocked Websites ({blockedSites.length})</Text>
          {blockedSites.map((r) => (
            <View key={r.id} style={styles.row}>
              <Text style={styles.rowLabel}>{r.domain}</Text>
              <Text style={styles.badge}>Blocked</Text>
            </View>
          ))}
        </View>
      )}

      {blockedApps.length === 0 && blockedSites.length === 0 && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>No Active Restrictions</Text>
          <Text style={styles.muted}>Your parent hasn't set any blocks yet.</Text>
        </View>
      )}

      <TouchableOpacity style={styles.refreshBtn} onPress={refresh}>
        <Text style={styles.refreshText}>Refresh</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function StatusRow({ label, on }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={{ color: on ? '#16a34a' : '#9ca3af', fontWeight: '600' }}>{on ? 'ON' : 'OFF'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f0f4ff' },
  content: { padding: 24, paddingTop: 60, gap: 16 },
  title: { fontSize: 28, fontWeight: 'bold', color: '#2563eb' },
  sub: { color: '#9ca3af', fontSize: 12, marginBottom: 8 },
  card: { backgroundColor: '#fff', borderRadius: 16, padding: 16 },
  cardTitle: { fontWeight: '700', fontSize: 15, marginBottom: 12, color: '#111827' },
  bigNum: { fontSize: 36, fontWeight: 'bold', color: '#2563eb', textAlign: 'center', marginBottom: 12 },
  barTrack: { height: 8, backgroundColor: '#e5e7eb', borderRadius: 4, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 4 },
  barLabel: { color: '#6b7280', fontSize: 12, marginTop: 6, textAlign: 'right' },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
  rowLabel: { color: '#374151', flex: 1 },
  badge: { color: '#ef4444', fontWeight: '600', fontSize: 13 },
  muted: { color: '#9ca3af', fontSize: 14 },
  refreshBtn: { backgroundColor: '#eff6ff', borderRadius: 12, padding: 14, alignItems: 'center' },
  refreshText: { color: '#2563eb', fontWeight: '600' },
});

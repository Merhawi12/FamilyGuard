import { useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert, Platform,
} from 'react-native';
import * as Location from 'expo-location';
import UsageStats from '../native/UsageStats';
import AppBlocker from '../native/AppBlocker';
import VpnControl from '../native/VpnControl';

const STEPS = [
  {
    id: 'location',
    title: 'Location Access',
    description: 'Required to report this device\'s location to the parent dashboard.',
    icon: '📍',
  },
  {
    id: 'usage',
    title: 'Usage Access',
    description: 'Required to track screen time. Goes to Android Settings → Apps → Usage Access → FamilyGuard.',
    icon: '📊',
  },
  {
    id: 'accessibility',
    title: 'Accessibility Service',
    description: 'Required to block apps. Goes to Android Settings → Accessibility → FamilyGuard → Enable.',
    icon: '🔒',
  },
  {
    id: 'vpn',
    title: 'VPN Permission',
    description: 'Required to block websites by filtering DNS traffic. No external VPN is used.',
    icon: '🌐',
  },
];

export default function PermissionsScreen({ navigation }) {
  const [statuses, setStatuses] = useState({
    location: false,
    usage: false,
    accessibility: false,
    vpn: false,
  });

  const checkAll = async () => {
    const [locFg] = await Location.getForegroundPermissionsAsync();
    const [locBg] = await Location.getBackgroundPermissionsAsync();
    const usage = await UsageStats.hasPermission();
    const accessibility = await AppBlocker.isAccessibilityEnabled();
    const vpn = await VpnControl.hasPermission();

    setStatuses({
      location: locFg.granted && locBg.granted,
      usage,
      accessibility,
      vpn,
    });
  };

  useEffect(() => {
    checkAll();
  }, []);

  const handleGrant = async (id) => {
    try {
      if (id === 'location') {
        const { granted: fgGranted } = await Location.requestForegroundPermissionsAsync();
        if (!fgGranted) return Alert.alert('Location required', 'Please grant location permission.');
        const { granted: bgGranted } = await Location.requestBackgroundPermissionsAsync();
        if (!bgGranted) Alert.alert('Background location', 'Background location was not granted. Location tracking will only work while the app is open.');
      } else if (id === 'usage') {
        UsageStats.openSettings();
        Alert.alert('Usage Access', 'Find FamilyGuard in the list and enable it, then return here.');
      } else if (id === 'accessibility') {
        AppBlocker.openSettings();
        Alert.alert('Accessibility', 'Find FamilyGuard, tap it, and toggle it on, then return here.');
      } else if (id === 'vpn') {
        const already = await VpnControl.requestPermission();
        if (!already) Alert.alert('VPN', 'Accept the VPN permission dialog when it appears.');
      }
    } catch (e) {
      console.warn('Permission grant error:', e);
    }
  };

  const allGranted = Object.values(statuses).every(Boolean);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>🛡️ FamilyGuard</Text>
      <Text style={styles.subtitle}>Grant the permissions below so monitoring can work.</Text>

      <ScrollView style={styles.list} contentContainerStyle={{ gap: 12 }}>
        {STEPS.map((step) => (
          <View key={step.id} style={[styles.card, statuses[step.id] && styles.cardDone]}>
            <View style={styles.cardRow}>
              <Text style={styles.icon}>{step.icon}</Text>
              <View style={styles.cardText}>
                <Text style={styles.cardTitle}>{step.title}</Text>
                <Text style={styles.cardDesc}>{step.description}</Text>
              </View>
              <Text style={styles.check}>{statuses[step.id] ? '✅' : '⬜'}</Text>
            </View>
            {!statuses[step.id] && (
              <TouchableOpacity style={styles.grantBtn} onPress={() => handleGrant(step.id)}>
                <Text style={styles.grantText}>Grant</Text>
              </TouchableOpacity>
            )}
          </View>
        ))}
      </ScrollView>

      <TouchableOpacity style={styles.refreshBtn} onPress={checkAll}>
        <Text style={styles.refreshText}>Re-check Permissions</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.continueBtn, !allGranted && styles.continueBtnDisabled]}
        onPress={() => navigation.replace('Home')}
      >
        <Text style={styles.continueBtnText}>
          {allGranted ? 'Start Monitoring →' : 'Skip for Now →'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, backgroundColor: '#f0f4ff', paddingTop: 60 },
  title: { fontSize: 28, fontWeight: 'bold', color: '#2563eb', marginBottom: 4 },
  subtitle: { color: '#6b7280', marginBottom: 24 },
  list: { flex: 1 },
  card: { backgroundColor: '#fff', borderRadius: 16, padding: 16, borderWidth: 1, borderColor: '#e5e7eb' },
  cardDone: { borderColor: '#16a34a', backgroundColor: '#f0fdf4' },
  cardRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  icon: { fontSize: 24, marginTop: 2 },
  cardText: { flex: 1 },
  cardTitle: { fontWeight: '600', fontSize: 15, color: '#111827' },
  cardDesc: { fontSize: 13, color: '#6b7280', marginTop: 4 },
  check: { fontSize: 18 },
  grantBtn: { marginTop: 12, backgroundColor: '#2563eb', borderRadius: 8, padding: 10, alignItems: 'center' },
  grantText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  refreshBtn: { marginTop: 16, padding: 12, alignItems: 'center' },
  refreshText: { color: '#2563eb', fontWeight: '500' },
  continueBtn: { backgroundColor: '#2563eb', borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 8 },
  continueBtnDisabled: { backgroundColor: '#93c5fd' },
  continueBtnText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
});

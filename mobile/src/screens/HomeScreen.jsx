import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, FlatList } from 'react-native';
import * as SecureStore from 'expo-secure-store';

export default function HomeScreen() {
  const [deviceId, setDeviceId] = useState(null);

  useEffect(() => {
    SecureStore.getItemAsync('fg_device_id').then(setDeviceId);
  }, []);

  const restrictions = [
    { id: '1', label: 'TikTok', status: 'Blocked' },
    { id: '2', label: 'Instagram', status: 'Blocked' },
    { id: '3', label: 'YouTube', status: '1h daily limit' },
  ];

  return (
    <View style={styles.container}>
      <Text style={styles.title}>🛡️ FamilyGuard</Text>
      <Text style={styles.sub}>This device is monitored</Text>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Active Restrictions</Text>
        <FlatList
          data={restrictions}
          keyExtractor={(i) => i.id}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>{item.label}</Text>
              <Text style={styles.rowStatus}>{item.status}</Text>
            </View>
          )}
        />
      </View>
      <Text style={styles.footer}>Device ID: {deviceId?.slice(0, 8)}...</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, backgroundColor: '#f0f4ff' },
  title: { fontSize: 28, fontWeight: 'bold', color: '#2563eb', marginTop: 48 },
  sub: { color: '#6b7280', marginBottom: 24 },
  card: { backgroundColor: '#fff', borderRadius: 16, padding: 16, marginBottom: 16 },
  cardTitle: { fontWeight: '600', marginBottom: 12, fontSize: 16 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
  rowLabel: { color: '#374151' },
  rowStatus: { color: '#ef4444', fontWeight: '500' },
  footer: { color: '#9ca3af', fontSize: 12, textAlign: 'center', marginTop: 'auto' },
});

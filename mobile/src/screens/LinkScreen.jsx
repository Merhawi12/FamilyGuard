import { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { device as deviceApi } from '../services/api';

export default function LinkScreen({ navigation }) {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLink = async () => {
    if (code.length !== 8) return Alert.alert('Invalid code', 'Enter the 8-character code from the parent app.');
    setLoading(true);
    try {
      const res = await deviceApi.confirmLink(code.toUpperCase());
      const { device, deviceToken } = res.data;

      await SecureStore.setItemAsync('fg_device_token', deviceToken);
      await SecureStore.setItemAsync('fg_device_id', String(device.id));
      await SecureStore.setItemAsync('fg_child_id', String(device.childId));

      navigation.replace('Permissions');
    } catch (err) {
      Alert.alert('Error', err.response?.data?.error || 'Failed to link device');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>🛡️ FamilyGuard</Text>
      <Text style={styles.subtitle}>Enter the linking code from your parent's app</Text>
      <TextInput
        style={styles.input}
        placeholder="e.g. A1B2C3D4"
        value={code}
        onChangeText={setCode}
        autoCapitalize="characters"
        maxLength={8}
      />
      <TouchableOpacity style={styles.btn} onPress={handleLink} disabled={loading}>
        <Text style={styles.btnText}>{loading ? 'Linking...' : 'Link Device'}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: '#f0f4ff' },
  title: { fontSize: 32, fontWeight: 'bold', color: '#2563eb', marginBottom: 8 },
  subtitle: { color: '#6b7280', textAlign: 'center', marginBottom: 32 },
  input: { width: '100%', backgroundColor: '#fff', borderRadius: 12, padding: 16, fontSize: 24, fontFamily: 'monospace', letterSpacing: 8, textAlign: 'center', borderWidth: 1, borderColor: '#e5e7eb', marginBottom: 16 },
  btn: { width: '100%', backgroundColor: '#2563eb', borderRadius: 12, padding: 16, alignItems: 'center' },
  btnText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
});

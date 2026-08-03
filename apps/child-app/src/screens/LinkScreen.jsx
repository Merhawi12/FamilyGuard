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

    // The request and the storage that follows it fail in different ways and
    // must not share a catch. Confirming the code marks the device linked on
    // the server, so once that call returns there is no such thing as "linking
    // failed" — only "linked, but this device could not keep its credentials".
    // Reporting both as one error hid a successful link behind a generic
    // message, and the code cannot be reused to try again.
    let res;
    try {
      res = await deviceApi.confirmLink(code.toUpperCase());
    } catch (err) {
      setLoading(false);
      // No response at all means the request never completed — no internet, no
      // DNS, or a TLS failure. Saying so beats a message about linking, which
      // sends people looking at the code they just typed.
      return Alert.alert(
        'Error',
        err.response?.data?.error ||
          'Could not reach Parentix. Check this device\'s internet connection and try again.'
      );
    }

    const { device, deviceToken } = res.data;

    try {
      await SecureStore.setItemAsync('fg_device_token', deviceToken);
      await SecureStore.setItemAsync('fg_device_id', String(device.id));
      await SecureStore.setItemAsync('fg_child_id', String(device.childId));
    } catch (err) {
      setLoading(false);
      // SecureStore is backed by the Android keystore, which is unavailable on
      // some emulator images. The device is already linked at this point, so
      // the only way forward is a fresh code.
      return Alert.alert(
        'Could not save credentials',
        'This device linked successfully but could not store its credentials securely ' +
          `(${err.message}). Remove the device in the parent app and link again.`
      );
    }

    setLoading(false);
    navigation.replace('Permissions');
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>🛡️ Parentix</Text>
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

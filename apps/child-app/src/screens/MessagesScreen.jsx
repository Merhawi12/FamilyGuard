import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, FlatList,
  KeyboardAvoidingView, Platform, Alert, ActivityIndicator,
} from 'react-native';
import { fetchMessages, sendMessage, sendEmergency, onMessage } from '../services/chat';

/** Message types the parent app can send that deserve a visible tag. */
const TYPE_LABELS = {
  emergency: '🚨 Emergency',
  check_in: '✅ Check-in',
};

export default function MessagesScreen({ navigation }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const listRef = useRef(null);

  const load = useCallback(async () => {
    try {
      setMessages(await fetchMessages());
      setError('');
    } catch (e) {
      setError(e.response?.data?.error || 'Could not load messages');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();

    // Live delivery from the parent. `onMessage` connects the shared socket if
    // it is not already up.
    let unsubscribe;
    onMessage((message) => {
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
    }).then((off) => { unsubscribe = off; });

    return () => unsubscribe?.();
  }, [load]);

  useEffect(() => {
    if (messages.length) listRef.current?.scrollToEnd({ animated: true });
  }, [messages.length]);

  const handleSend = async (messageType = 'normal') => {
    const body = messageType === 'emergency' ? 'Emergency — I need help' : text.trim();
    if (!body || sending) return;

    setSending(true);
    setError('');
    try {
      if (messageType === 'emergency') await sendEmergency();
      else await sendMessage(body);

      setText('');
      // The socket echoes the parent's copy, not ours, so re-read the thread to
      // pick up what was actually stored.
      await load();
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Could not send');
    } finally {
      setSending(false);
    }
  };

  const confirmEmergency = () => {
    Alert.alert(
      'Send emergency alert?',
      'Your parent is notified straight away with a high-priority alert.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Send alert', style: 'destructive', onPress: () => handleSend('emergency') },
      ]
    );
  };

  const renderItem = ({ item }) => {
    const mine = item.senderRole === 'child';
    const tag = TYPE_LABELS[item.messageType];
    return (
      <View style={[styles.bubbleRow, mine ? styles.rowSelf : styles.rowOther]}>
        <View style={[
          styles.bubble,
          mine ? styles.bubbleSelf : styles.bubbleOther,
          item.messageType === 'emergency' && styles.bubbleEmergency,
        ]}>
          {tag && <Text style={styles.bubbleTag}>{tag}</Text>}
          <Text style={[styles.bubbleText, mine && styles.bubbleTextSelf]}>{item.text}</Text>
          <Text style={[styles.bubbleTime, mine && styles.bubbleTimeSelf]}>
            {new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
        </View>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.back}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Messages</Text>
        <TouchableOpacity onPress={confirmEmergency}>
          <Text style={styles.sos}>🚨 SOS</Text>
        </TouchableOpacity>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {loading ? (
        <ActivityIndicator style={{ marginTop: 32 }} color="#2563eb" />
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => String(m.id)}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <Text style={styles.empty}>No messages yet. Say hello to your parent.</Text>
          }
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        />
      )}

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          placeholder="Write a message…"
          value={text}
          onChangeText={setText}
          multiline
          maxLength={1000}
          onSubmitEditing={() => handleSend()}
        />
        <TouchableOpacity
          style={[styles.sendBtn, (!text.trim() || sending) && styles.sendBtnDisabled]}
          onPress={() => handleSend()}
          disabled={!text.trim() || sending}
        >
          <Text style={styles.sendText}>{sending ? '…' : 'Send'}</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f0f4ff' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 56, paddingHorizontal: 20, paddingBottom: 12,
    backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#e5e7eb',
  },
  back: { color: '#2563eb', fontSize: 16, fontWeight: '600' },
  title: { fontSize: 18, fontWeight: '700', color: '#111827' },
  sos: { color: '#dc2626', fontWeight: '700', fontSize: 15 },
  error: { color: '#b91c1c', backgroundColor: '#fef2f2', padding: 10, fontSize: 13, textAlign: 'center' },
  list: { padding: 16, gap: 10 },
  empty: { color: '#9ca3af', textAlign: 'center', marginTop: 40, fontSize: 14 },
  bubbleRow: { flexDirection: 'row' },
  rowSelf: { justifyContent: 'flex-end' },
  rowOther: { justifyContent: 'flex-start' },
  bubble: { maxWidth: '80%', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10 },
  bubbleSelf: { backgroundColor: '#2563eb', borderBottomRightRadius: 4 },
  bubbleOther: { backgroundColor: '#fff', borderBottomLeftRadius: 4 },
  bubbleEmergency: { backgroundColor: '#dc2626' },
  bubbleCheckIn: { backgroundColor: '#16a34a' },
  bubbleTag: { fontSize: 11, fontWeight: '700', color: '#fff', marginBottom: 4 },
  bubbleText: { color: '#111827', fontSize: 15 },
  bubbleTextSelf: { color: '#fff' },
  bubbleTime: { fontSize: 10, color: '#9ca3af', marginTop: 4, textAlign: 'right' },
  bubbleTimeSelf: { color: '#dbeafe' },
  composer: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 12,
    backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#e5e7eb',
  },
  input: {
    flex: 1, backgroundColor: '#f3f4f6', borderRadius: 20,
    paddingHorizontal: 16, paddingVertical: 10, maxHeight: 110, fontSize: 15,
  },
  sendBtn: { backgroundColor: '#2563eb', borderRadius: 20, paddingHorizontal: 20, paddingVertical: 11 },
  sendBtnDisabled: { backgroundColor: '#93c5fd' },
  sendText: { color: '#fff', fontWeight: '700' },
});

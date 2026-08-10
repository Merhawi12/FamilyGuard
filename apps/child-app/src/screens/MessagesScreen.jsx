import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Platform,
  StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import AppShell from '../components/AppShell';
import Icon from '../components/Icon';
import { EmptyNote } from '../components/ui';
import { fetchMessages, sendMessage, sendEmergency, onMessage } from '../services/chat';
import { colors, radius, space, TAP } from '../theme';

/** Message types the parent app can send that deserve a visible tag. */
const TYPE_LABELS = {
  emergency: 'Emergency',
  check_in: 'Check-in',
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
    const emergency = item.messageType === 'emergency';
    const tag = TYPE_LABELS[item.messageType];

    return (
      <View style={[styles.bubbleRow, mine ? styles.rowSelf : styles.rowOther]}>
        <View style={[
          styles.bubble,
          mine ? styles.bubbleSelf : styles.bubbleOther,
          emergency && styles.bubbleEmergency,
        ]}>
          {!!tag && (
            <View style={styles.tagRow}>
              <Icon name={emergency ? 'sos' : 'check'} size={13} color={colors.white} />
              <Text style={styles.tagText}>{tag}</Text>
            </View>
          )}
          <Text style={[styles.bubbleText, (mine || emergency) && styles.bubbleTextLight]}>
            {item.text}
          </Text>
          <Text style={[styles.bubbleTime, (mine || emergency) && styles.bubbleTimeLight]}>
            {new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
        </View>
      </View>
    );
  };

  return (
    <AppShell route="Messages" navigation={navigation} scroll={false}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <TouchableOpacity
          onPress={confirmEmergency}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Send an emergency alert to your parent"
          style={styles.sos}
        >
          <View style={styles.sosIcon}>
            <Icon name="sos" size={20} color={colors.white} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.sosTitle}>Need help right now?</Text>
            <Text style={styles.sosText}>Tap to send an emergency alert.</Text>
          </View>
          <Icon name="forward" size={18} color={colors.danger} />
        </TouchableOpacity>

        {!!error && (
          <View style={styles.error}>
            <Icon name="warningOutline" size={16} color={colors.danger} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {loading ? (
          <ActivityIndicator style={{ marginTop: space.xxl }} color={colors.teal600} />
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(m) => String(m.id)}
            renderItem={renderItem}
            contentContainerStyle={styles.list}
            ListEmptyComponent={
              <EmptyNote
                icon="messages"
                title="No messages yet"
                text="Say hello to your parent, or ask them for something."
              />
            }
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          />
        )}

        <View style={styles.composer}>
          <TextInput
            style={styles.input}
            placeholder="Write a message…"
            placeholderTextColor={colors.muted}
            value={text}
            onChangeText={setText}
            multiline
            maxLength={1000}
            accessibilityLabel="Message"
            onSubmitEditing={() => handleSend()}
          />
          <TouchableOpacity
            style={[styles.send, (!text.trim() || sending) && styles.sendDisabled]}
            onPress={() => handleSend()}
            disabled={!text.trim() || sending}
            accessibilityRole="button"
            accessibilityLabel="Send message"
          >
            <Icon name="send" size={19} color={colors.white} />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </AppShell>
  );
}

const styles = StyleSheet.create({
  sos: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    padding: space.md,
    borderRadius: radius.lg,
    backgroundColor: colors.dangerSoft,
    borderWidth: 1,
    borderColor: '#F7D4D5',
  },
  sosIcon: {
    width: 38, height: 38, borderRadius: 19, backgroundColor: colors.danger,
    alignItems: 'center', justifyContent: 'center',
  },
  sosTitle: { fontSize: 14.5, fontWeight: '800', color: colors.danger },
  sosText: { fontSize: 12.5, fontWeight: '500', color: '#9A5254', marginTop: 1 },

  error: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    marginHorizontal: space.lg, marginBottom: space.sm,
    paddingHorizontal: space.md, paddingVertical: space.sm,
    borderRadius: radius.md, backgroundColor: colors.dangerSoft,
  },
  errorText: { flex: 1, fontSize: 13, fontWeight: '600', color: colors.danger },

  list: { padding: space.lg, paddingTop: space.sm, gap: space.sm },
  bubbleRow: { flexDirection: 'row' },
  rowSelf: { justifyContent: 'flex-end' },
  rowOther: { justifyContent: 'flex-start' },
  bubble: { maxWidth: '82%', borderRadius: radius.lg, paddingHorizontal: space.lg, paddingVertical: space.md },
  bubbleSelf: { backgroundColor: colors.teal700, borderBottomRightRadius: 6 },
  bubbleOther: {
    backgroundColor: colors.surface, borderBottomLeftRadius: 6,
    borderWidth: 1, borderColor: colors.line,
  },
  bubbleEmergency: { backgroundColor: colors.danger, borderColor: colors.danger },
  tagRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 5 },
  tagText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.6, color: colors.white },
  bubbleText: { fontSize: 15, fontWeight: '500', color: colors.ink },
  bubbleTextLight: { color: colors.white },
  bubbleTime: { fontSize: 10.5, fontWeight: '600', color: colors.muted, marginTop: 5, textAlign: 'right' },
  bubbleTimeLight: { color: colors.teal200 },

  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  input: {
    flex: 1,
    minHeight: TAP,
    maxHeight: 120,
    backgroundColor: colors.canvas,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: space.lg,
    paddingTop: 13,
    paddingBottom: 13,
    fontSize: 15,
    color: colors.ink,
  },
  send: {
    width: TAP, height: TAP, borderRadius: TAP / 2,
    backgroundColor: colors.teal700,
    alignItems: 'center', justifyContent: 'center',
  },
  sendDisabled: { backgroundColor: colors.teal200 },
});

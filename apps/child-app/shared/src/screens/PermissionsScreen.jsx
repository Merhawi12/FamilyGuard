import { useEffect, useState } from 'react';
import {
  Alert, ScrollView, StatusBar, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import * as Location from 'expo-location';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Icon from '../components/Icon';
import { Button, Card } from '../components/ui';
import UsageStats from '../native/UsageStats';
import AppBlocker from '../native/AppBlocker';
import VpnControl from '../native/VpnControl';
import { checkPermission as checkPushPermission, requestPermission as requestPushPermission, registerForPush } from '../services/push';
import { colors, radius, space, type } from '../theme';

/**
 * Every step this screen can offer, and what has to be true for it to appear.
 *
 * `available` is what keeps the iOS build honest. Three of these five are
 * Android-only — not unimplemented, but impossible, for the reasons written at
 * the top of each module in ../native. Listing them anyway would give a child an
 * iPhone setup screen with three rows that can never turn green and instructions
 * naming Android settings screens that do not exist, and would leave the "all
 * set up" state permanently out of reach.
 *
 * Read from the native modules rather than from `Platform.OS` directly, so the
 * question each row answers is "can this device do it?" rather than "which OS is
 * this?" — the same answer today, and the right one to have written down if the
 * Family Controls work in docs/IOS.md ever lands.
 */
const STEPS = [
  {
    id: 'location',
    title: 'Location',
    description: 'Lets your parent see where this phone is on their map.',
    icon: 'location',
    available: true,
  },
  {
    id: 'usage',
    title: 'Usage access',
    description: 'Counts your screen time. Android Settings → Apps → Usage Access → Parentix.',
    icon: 'usage',
    available: UsageStats.supported,
  },
  {
    id: 'accessibility',
    title: 'App blocking',
    description: 'Pauses apps your parent has blocked. Android Settings → Accessibility → Parentix.',
    icon: 'apps',
    available: AppBlocker.supported,
  },
  {
    id: 'vpn',
    title: 'Website filtering',
    description: 'Filters websites on this phone only. No outside VPN is used.',
    icon: 'globe',
    available: VpnControl.supported,
  },
  {
    id: 'notifications',
    title: 'Notifications',
    description: 'Lets your parent reach you even when this app is closed.',
    icon: 'bell',
    available: true,
  },
].filter((step) => step.available);

export default function PermissionsScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [statuses, setStatuses] = useState({
    location: false,
    usage: false,
    accessibility: false,
    vpn: false,
    notifications: false,
  });

  // Reached from Link during setup the stack has nowhere to go back to; reached
  // from Settings it does. That difference is the whole difference between
  // "finish setting up" and "I was just checking".
  const setup = !navigation.canGoBack();

  const checkAll = async () => {
    // These resolve to a permission *object*, not a tuple — array-destructuring
    // them threw, so this whole check used to fail and every row rendered as
    // "not granted" no matter what the child had actually allowed.
    try {
      const [locFg, locBg, usage, accessibility, vpn, push] = await Promise.all([
        Location.getForegroundPermissionsAsync(),
        Location.getBackgroundPermissionsAsync(),
        UsageStats.hasPermission(),
        AppBlocker.isAccessibilityEnabled(),
        VpnControl.hasPermission(),
        // Read, never requested — checking the screen must not raise a prompt.
        checkPushPermission(),
      ]);

      setStatuses({
        location: !!locFg?.granted && !!locBg?.granted,
        usage: !!usage,
        accessibility: !!accessibility,
        vpn: !!vpn,
        notifications: push === 'granted',
      });
    } catch (e) {
      console.warn('[permissions] check failed:', e?.message);
    }
  };

  useEffect(() => {
    checkAll();
  }, []);

  const handleGrant = async (id) => {
    try {
      if (id === 'location') {
        const { granted: fgGranted } = await Location.requestForegroundPermissionsAsync();
        if (!fgGranted) return Alert.alert('Location needed', 'Please allow location for Parentix.');
        const { granted: bgGranted } = await Location.requestBackgroundPermissionsAsync();
        if (!bgGranted) Alert.alert('Background location', 'Background location was not granted. Location will only work while this app is open.');
      } else if (id === 'usage') {
        UsageStats.openSettings();
        Alert.alert('Usage access', 'Find Parentix in the list and turn it on, then come back here.');
      } else if (id === 'accessibility') {
        AppBlocker.openSettings();
        Alert.alert('App blocking', 'Find Parentix, tap it, and switch it on, then come back here.');
      } else if (id === 'vpn') {
        const already = await VpnControl.requestPermission();
        if (!already) Alert.alert('Website filtering', 'Accept the prompt when it appears.');
      } else if (id === 'notifications') {
        const result = await requestPushPermission();
        if (result.granted) {
          // Register straight away: the token only exists once permission is
          // granted, and waiting for the next launch would leave a window where
          // the child has said yes but nothing can reach them.
          await registerForPush();
        } else if (result.mustUseSettings) {
          // Android will not show the prompt a second time, so pointing at
          // system settings is the only thing left that helps.
          Alert.alert(
            'Notifications are off',
            'Android will not ask again. Turn notifications on for Parentix in Settings → Apps → Parentix → Notifications.',
          );
        } else if (result.status === 'unsupported') {
          Alert.alert('Not available', 'Notifications need a real device — an emulator cannot receive them.');
        }
      }
      await checkAll();
    } catch (e) {
      console.warn('Permission grant error:', e);
    }
  };

  const granted = STEPS.filter((step) => statuses[step.id]).length;
  const allGranted = granted === STEPS.length;

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={colors.teal700} />

      <View style={[styles.header, { paddingTop: insets.top + space.lg }]}>
        <View style={styles.headerTop}>
          {!setup && (
            <TouchableOpacity
              onPress={() => navigation.goBack()}
              style={styles.back}
              accessibilityRole="button"
              accessibilityLabel="Go back"
            >
              <Icon name="back" size={22} color={colors.white} />
            </TouchableOpacity>
          )}
          <View style={{ flex: 1 }}>
            {setup && <Text style={styles.headerEyebrow}>STEP 2 OF 2</Text>}
            <Text style={styles.headerTitle}>Permissions</Text>
          </View>
        </View>

        <Text style={styles.headerText}>
          Turn these on so Parentix can do its job. You can change them any time.
        </Text>

        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${(granted / STEPS.length) * 100}%` }]} />
        </View>
        <Text style={styles.progressLabel}>{granted} of {STEPS.length} turned on</Text>
      </View>

      <ScrollView
        style={styles.body}
        contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.xxl }}
        showsVerticalScrollIndicator={false}
      >
        {STEPS.map((step) => {
          const on = statuses[step.id];
          return (
            <Card key={step.id} style={[styles.step, on && styles.stepDone]}>
              <View style={[styles.stepIcon, on && styles.stepIconDone]}>
                <Icon name={step.icon} size={20} color={on ? colors.white : colors.teal700} />
              </View>

              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={styles.stepTitleRow}>
                  <Text style={type.section}>{step.title}</Text>
                  {on && <Icon name="check" size={18} color={colors.success} />}
                </View>
                <Text style={[type.small, { marginTop: 3 }]}>{step.description}</Text>

                {!on && (
                  <Button
                    title="Turn on"
                    kind="secondary"
                    style={{ marginTop: space.md, alignSelf: 'flex-start', paddingHorizontal: space.xxl }}
                    onPress={() => handleGrant(step.id)}
                    accessibilityLabel={`Turn on ${step.title}`}
                  />
                )}
              </View>
            </Card>
          );
        })}

        <Button title="Check again" kind="ghost" icon="refresh" onPress={checkAll} />
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + space.lg }]}>
        {setup ? (
          <Button
            title={allGranted ? 'All set — let’s go' : 'Continue for now'}
            icon={allGranted ? 'check' : undefined}
            onPress={() => navigation.replace('Home')}
          />
        ) : (
          <Button title="Done" icon="check" onPress={() => navigation.goBack()} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },

  header: {
    backgroundColor: colors.teal700,
    paddingHorizontal: space.xl,
    paddingBottom: space.xl,
    borderBottomLeftRadius: 28,
    borderBottomRightRadius: 28,
  },
  headerTop: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  back: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center', justifyContent: 'center',
  },
  headerEyebrow: { fontSize: 10.5, fontWeight: '800', letterSpacing: 1.6, color: colors.teal200 },
  headerTitle: { fontSize: 26, fontWeight: '800', color: colors.white, letterSpacing: -0.4 },
  headerText: { fontSize: 13.5, fontWeight: '500', color: colors.teal100, marginTop: space.sm },

  progressTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.2)',
    marginTop: space.lg,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', borderRadius: 4, backgroundColor: colors.teal300 },
  progressLabel: { fontSize: 11.5, fontWeight: '700', color: colors.teal100, marginTop: 6 },

  body: { flex: 1 },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  stepDone: { backgroundColor: colors.teal50, borderColor: colors.teal100 },
  stepIcon: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: colors.teal50,
    alignItems: 'center', justifyContent: 'center',
  },
  stepIconDone: { backgroundColor: colors.success },
  stepTitleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },

  footer: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
});

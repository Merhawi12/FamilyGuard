import { useEffect, useState } from 'react';
import {
  Keyboard, RefreshControl, ScrollView, StatusBar, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Icon from './Icon';
import DrawerMenu from './DrawerMenu';
import { TAB_ITEMS, titleFor } from '../navigation';
import { getDeviceId } from '../services/link';
import { loadChildName } from '../services/profile';
import { colors, radius, shadow, space, type, TAP } from '../theme';

/**
 * The frame every signed-in screen sits in: header, slide-in menu, bottom bar.
 *
 * The header owns the page title, so a screen renders its content and nothing
 * else — no screen can forget to title itself, and none of them can disagree
 * with the tab that is lit.
 *
 * `scroll` is false for screens that own their own scrolling (the message
 * thread scrolls a list and pins a composer to the keyboard); everything else
 * gets the standard padded scroll view.
 */
export default function AppShell({
  route, navigation, children, scroll = true, contentStyle, refreshing, onRefresh,
}) {
  const insets = useSafeAreaInsets();
  const [menuOpen, setMenuOpen] = useState(false);
  const [childName, setChildName] = useState(null);
  const [deviceId, setDeviceId] = useState(null);
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    let alive = true;
    loadChildName().then((name) => { if (alive) setChildName(name); });
    getDeviceId()
      .catch(() => null)
      .then((id) => { if (alive) setDeviceId(id); });
    return () => { alive = false; };
  }, []);

  // Android shrinks the window for the keyboard, which left the tab bar wedged
  // between the message box and the keys — a row of navigation nobody is aiming
  // for, directly under the thing they are typing into. It stands down while
  // the keyboard is up and comes back when it goes away.
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', () => setTyping(true));
    const hidden = Keyboard.addListener('keyboardDidHide', () => setTyping(false));
    return () => { shown.remove(); hidden.remove(); };
  }, []);

  // Navigating to the screen you are already on would stack a second copy of it
  // behind the first, which the back button then has to unwind.
  const go = (target) => { if (target !== route) navigation.navigate(target); };

  const tabBarHeight = typing ? 0 : 62 + insets.bottom;

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.canvas} />

      <View style={[styles.header, { paddingTop: insets.top + space.md }]}>
        <TouchableOpacity
          onPress={() => setMenuOpen(true)}
          style={styles.menuBtn}
          accessibilityRole="button"
          accessibilityLabel="Open menu"
          accessibilityState={{ expanded: menuOpen }}
        >
          <Icon name="menu" size={24} color={colors.white} />
        </TouchableOpacity>

        <View style={styles.headerTitle}>
          <Text style={type.eyebrow}>HELLO!</Text>
          <Text style={styles.title} numberOfLines={1}>{titleFor(route).toUpperCase()}</Text>
        </View>

        <HeaderButton
          icon="bell"
          label="Messages"
          active={route === 'Messages'}
          onPress={() => go('Messages')}
        />
        <HeaderButton
          icon="settingsOutline"
          label="Settings"
          active={route === 'Settings'}
          onPress={() => go('Settings')}
        />
      </View>

      {scroll ? (
        <ScrollView
          style={styles.body}
          contentContainerStyle={[
            { padding: space.lg, paddingBottom: tabBarHeight + space.xxl, gap: space.lg },
            contentStyle,
          ]}
          showsVerticalScrollIndicator={false}
          refreshControl={onRefresh
            ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={colors.teal600} colors={[colors.teal600]} />
            : undefined}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.body, { marginBottom: tabBarHeight }, contentStyle]}>{children}</View>
      )}

      <View
        style={[styles.tabBar, { height: tabBarHeight, paddingBottom: insets.bottom }]}
        pointerEvents={typing ? 'none' : 'auto'}
      >
        {!typing && TAB_ITEMS.map((item) => {
          const active = item.route === route;
          return (
            <TouchableOpacity
              key={item.route}
              onPress={() => go(item.route)}
              style={styles.tab}
              activeOpacity={0.7}
              accessibilityRole="tab"
              accessibilityLabel={item.label}
              accessibilityState={{ selected: active }}
            >
              <Icon
                name={active ? item.icon : item.tabIcon}
                size={23}
                color={active ? colors.teal700 : colors.muted}
              />
              <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{item.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <DrawerMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        current={route}
        onNavigate={go}
        childName={childName}
        deviceId={deviceId}
      />
    </View>
  );
}

function HeaderButton({ icon, label, active, onPress }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.headerBtn, active && styles.headerBtnActive]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active }}
    >
      <Icon name={icon} size={20} color={active ? colors.teal700 : colors.teal600} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    backgroundColor: colors.canvas,
  },
  menuBtn: {
    width: 46, height: 46, borderRadius: radius.md,
    backgroundColor: colors.teal700,
    alignItems: 'center', justifyContent: 'center',
    ...shadow.card,
  },
  headerTitle: { flex: 1, minWidth: 0, marginLeft: space.xs },
  title: { fontSize: 22, fontWeight: '800', color: colors.ink, letterSpacing: -0.3 },
  headerBtn: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.line,
    alignItems: 'center', justifyContent: 'center',
  },
  headerBtnActive: { backgroundColor: colors.teal100, borderColor: colors.teal200 },

  body: { flex: 1 },

  tabBar: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  tab: {
    flex: 1,
    minHeight: TAP,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingTop: space.sm,
  },
  tabLabel: { fontSize: 11.5, fontWeight: '700', color: colors.muted },
  tabLabelActive: { color: colors.teal700 },
});

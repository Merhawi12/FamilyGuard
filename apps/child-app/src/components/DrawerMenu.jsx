import { useEffect, useRef, useState } from 'react';
import {
  Animated, Dimensions, Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import Icon from './Icon';
import { MENU_SECTIONS } from '../navigation';
import { colors, radius, shadow, space, type, TAP } from '../theme';

/**
 * The slide-in menu.
 *
 * It is a `Modal` rather than an absolutely-positioned view so Android's back
 * button closes it (`onRequestClose`) and everything behind it is taken out of
 * the accessibility tree while it is open — both of which a child will hit long
 * before they find the close button.
 *
 * The panel stays mounted through its closing animation and unmounts after,
 * which is what lets it slide out instead of vanishing.
 *
 * The sections are labelled but do not fold. There are four destinations here:
 * a fold control would add a tap and hide something a child was looking at,
 * which is the opposite of what grouping is for.
 */
export default function DrawerMenu({ open, onClose, current, onNavigate, childName, deviceId }) {
  const [mounted, setMounted] = useState(open);
  const slide = useRef(new Animated.Value(open ? 1 : 0)).current;
  const width = Math.min(320, Dimensions.get('window').width * 0.84);

  useEffect(() => {
    if (open) {
      setMounted(true);
      Animated.timing(slide, { toValue: 1, duration: 240, useNativeDriver: true }).start();
    } else {
      Animated.timing(slide, { toValue: 0, duration: 200, useNativeDriver: true })
        .start(({ finished }) => { if (finished) setMounted(false); });
    }
  }, [open, slide]);

  if (!mounted) return null;

  const go = (route) => {
    onClose();
    // Let the panel start moving before the screen underneath changes, or the
    // new screen appears to flash in behind a menu that is still fully open.
    if (route !== current) setTimeout(() => onNavigate(route), 120);
  };

  return (
    <Modal transparent visible animationType="none" statusBarTranslucent onRequestClose={onClose}>
      <Animated.View style={[styles.backdrop, { opacity: slide }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close menu" />
      </Animated.View>

      <Animated.View
        accessibilityViewIsModal
        style={[
          styles.panel,
          { width, transform: [{ translateX: slide.interpolate({ inputRange: [0, 1], outputRange: [-width, 0] }) }] },
        ]}
      >
        <View style={styles.header}>
          <View style={styles.avatar}>
            <Icon name="shieldOutline" size={22} color={colors.white} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.headerEyebrow}>HELLO!</Text>
            <Text style={styles.headerName} numberOfLines={1}>{childName || 'Welcome back'}</Text>
          </View>
          <TouchableOpacity
            onPress={onClose}
            style={styles.headerClose}
            accessibilityRole="button"
            accessibilityLabel="Close menu"
          >
            <Icon name="close" size={22} color={colors.white} />
          </TouchableOpacity>
        </View>

        <ScrollView
          contentContainerStyle={{ padding: space.md, paddingBottom: space.xxl }}
          accessibilityRole="menu"
        >
          {MENU_SECTIONS.map((section) => (
            <View key={section.id} style={{ marginBottom: space.lg }}>
              <Text style={styles.sectionLabel}>{section.label.toUpperCase()}</Text>

              {section.items.map((item) => {
                const active = item.route === current;
                return (
                  <TouchableOpacity
                    key={item.route}
                    onPress={() => go(item.route)}
                    activeOpacity={0.8}
                    accessibilityRole="menuitem"
                    accessibilityLabel={item.label}
                    accessibilityState={{ selected: active }}
                    style={[styles.item, active && styles.itemActive]}
                  >
                    <View style={[styles.itemIcon, active && styles.itemIconActive]}>
                      <Icon name={item.icon} size={19} color={active ? colors.white : colors.teal700} />
                    </View>
                    <Text style={[styles.itemLabel, active && styles.itemLabelActive]} numberOfLines={1}>
                      {item.label}
                    </Text>
                    {active && <Icon name="forward" size={16} color={colors.white} />}
                  </TouchableOpacity>
                );
              })}
            </View>
          ))}
        </ScrollView>

        <View style={styles.footer}>
          <Text style={styles.footerTitle}>Parentix</Text>
          <Text style={styles.footerText} numberOfLines={1}>
            {deviceId ? `Linked device · ${deviceId.slice(0, 8)}` : 'Linked to your parent'}
          </Text>
        </View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(6, 82, 91, 0.55)' },
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.surface,
    borderTopRightRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
    overflow: 'hidden',
    ...shadow.lifted,
  },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.teal700,
    paddingTop: 54,
    paddingBottom: space.xl,
    paddingHorizontal: space.lg,
  },
  avatar: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
  },
  headerEyebrow: { fontSize: 10.5, fontWeight: '800', letterSpacing: 1.6, color: colors.teal200 },
  headerName: { fontSize: 18, fontWeight: '800', color: colors.white, marginTop: 1 },
  headerClose: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center', justifyContent: 'center',
  },

  sectionLabel: {
    ...type.eyebrow,
    color: colors.muted,
    marginLeft: space.md,
    marginBottom: space.sm,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: TAP + 4,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    marginBottom: 4,
  },
  itemActive: { backgroundColor: colors.teal700 },
  itemIcon: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: colors.teal50,
    alignItems: 'center', justifyContent: 'center',
  },
  itemIconActive: { backgroundColor: 'rgba(255,255,255,0.2)' },
  itemLabel: { flex: 1, fontSize: 15.5, fontWeight: '700', color: colors.ink },
  itemLabelActive: { color: colors.white },

  footer: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingHorizontal: space.lg,
    paddingVertical: space.lg,
    backgroundColor: colors.teal50,
  },
  footerTitle: { fontSize: 13, fontWeight: '800', color: colors.teal800 },
  footerText: { fontSize: 11.5, fontWeight: '600', color: colors.muted, marginTop: 2 },
});

import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Icon from './Icon';
import { colors, radius, shadow, space, type, TAP } from '../theme';

/**
 * The pieces every screen is built from.
 *
 * Keeping the card corner radius, the button height and the pill shape in one
 * file is what stops four screens drifting into four slightly different buttons
 * — and it is why a tap-target fix lands everywhere at once.
 */

export function Card({ children, style, tone = 'surface' }) {
  return <View style={[styles.card, tone === 'teal' && styles.cardTeal, style]}>{children}</View>;
}

export function SectionTitle({ children, hint, style }) {
  return (
    <View style={[{ marginBottom: space.md }, style]}>
      <Text style={type.section}>{children}</Text>
      {!!hint && <Text style={[type.caption, { marginTop: 2 }]}>{hint}</Text>}
    </View>
  );
}

/**
 * `kind` picks the intent, never the size — a child's button is always the same
 * height so nothing on any screen is harder to hit than anything else.
 *
 * The label colour is kept here rather than read back out of the stylesheet:
 * the icon has to match the text, and what `StyleSheet.create` hands back is
 * not contractually an object you can index into.
 */
const BUTTON_TEXT = {
  primary: colors.white,
  secondary: colors.teal800,
  ghost: colors.teal700,
  danger: colors.danger,
};

export function Button({
  title, onPress, kind = 'primary', icon, disabled, style, accessibilityLabel,
}) {
  const tone = styles[`btn_${kind}`] || styles.btn_primary;
  const textColor = BUTTON_TEXT[kind] || BUTTON_TEXT.primary;

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || title}
      accessibilityState={{ disabled: !!disabled }}
      style={[styles.btn, tone, disabled && styles.btnDisabled, style]}
    >
      {!!icon && <Icon name={icon} size={18} color={textColor} />}
      <Text style={[styles.btnText, { color: textColor }]}>{title}</Text>
    </TouchableOpacity>
  );
}

/** A read-only status pill: the shape a child scans rather than reads. */
export function Pill({ label, icon, tone = 'teal', style }) {
  const fill = {
    teal: { bg: colors.teal100, fg: colors.teal800 },
    warning: { bg: colors.warningSoft, fg: colors.warning },
    danger: { bg: colors.dangerSoft, fg: colors.danger },
    success: { bg: colors.successSoft, fg: colors.success },
    plain: { bg: colors.canvas, fg: colors.body },
  }[tone];

  return (
    <View style={[styles.pill, { backgroundColor: fill.bg }, style]}>
      {!!icon && <Icon name={icon} size={14} color={fill.fg} />}
      <Text style={[styles.pillText, { color: fill.fg }]}>{label}</Text>
    </View>
  );
}

/** A labelled row inside a card — the shape used for every list of facts. */
export function Row({ label, value, icon, tone = 'plain', last }) {
  const TONES = {
    plain: colors.body,
    success: colors.success,
    // `Pill` has had a warning tone since it was written; this map did not, so a
    // row asking for one rendered its value in `undefined` — invisible on some
    // Android builds, black on others, and never the amber it asked for.
    warning: colors.warning,
    danger: colors.danger,
    muted: colors.muted,
  };
  const fg = TONES[tone] || TONES.plain;
  return (
    <View style={[styles.row, last && { borderBottomWidth: 0 }]}>
      {!!icon && <Icon name={icon} size={18} color={colors.teal600} />}
      <Text style={[type.small, { flex: 1, color: colors.ink }]} numberOfLines={2}>{label}</Text>
      <Text style={[styles.rowValue, { color: fg }]}>{value}</Text>
    </View>
  );
}

export function EmptyNote({ icon = 'sparkle', title, text }) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Icon name={icon} size={24} color={colors.teal600} />
      </View>
      <Text style={[type.section, { textAlign: 'center' }]}>{title}</Text>
      {!!text && <Text style={[type.small, { textAlign: 'center', marginTop: 4 }]}>{text}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: space.lg,
    borderWidth: 1,
    borderColor: colors.line,
    ...shadow.card,
  },
  cardTeal: { backgroundColor: colors.teal700, borderColor: colors.teal700 },

  btn: {
    minHeight: TAP,
    borderRadius: radius.pill,
    paddingHorizontal: space.xl,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
  },
  btn_primary: { backgroundColor: colors.teal700 },
  btn_secondary: { backgroundColor: colors.teal100 },
  btn_ghost: { backgroundColor: 'transparent' },
  btn_danger: { backgroundColor: colors.dangerSoft },
  btnDisabled: { opacity: 0.45 },
  btnText: { fontSize: 15, fontWeight: '800' },
  btnText_primary: { color: colors.white },
  btnText_secondary: { color: colors.teal800 },
  btnText_ghost: { color: colors.teal700 },
  btnText_danger: { color: colors.danger },

  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: space.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
  },
  pillText: { fontSize: 12.5, fontWeight: '800' },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  rowValue: { fontSize: 13, fontWeight: '800' },

  empty: { alignItems: 'center', paddingVertical: space.xl, gap: space.sm },
  emptyIcon: {
    width: 52, height: 52, borderRadius: 26, backgroundColor: colors.teal50,
    alignItems: 'center', justifyContent: 'center',
  },
});

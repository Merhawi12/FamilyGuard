import { View } from 'react-native';
import { colors } from '../theme';

/**
 * A circular progress ring, drawn with borders alone.
 *
 * The obvious way to do this is `react-native-svg`, which is a native module —
 * adding one would mean a fresh Android build before anybody could see the
 * screen. This uses the border trick instead: a ring with only its top and
 * right sides coloured is exactly a 180° arc, and two of them behind half-width
 * clips sweep the full circle.
 *
 *   arc rotated by (θ − 135°) spans (θ − 180°) … θ
 *   the right clip reveals 0…180°, the left clip reveals 180…360°
 *
 * so one rotation drives both halves, and the left half is only mounted once
 * the value passes the halfway mark.
 */
export default function ProgressRing({
  size = 188,
  stroke = 14,
  progress = 0,
  color = colors.teal500,
  track = colors.teal100,
  children,
}) {
  const value = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  const angle = value * 360;
  const half = size / 2;

  const arc = {
    position: 'absolute',
    top: 0,
    width: size,
    height: size,
    borderRadius: half,
    borderWidth: stroke,
    borderTopColor: color,
    borderRightColor: color,
    borderBottomColor: 'transparent',
    borderLeftColor: 'transparent',
  };

  const clip = { position: 'absolute', top: 0, width: half, height: size, overflow: 'hidden' };

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View
        style={{
          position: 'absolute',
          width: size,
          height: size,
          borderRadius: half,
          borderWidth: stroke,
          borderColor: track,
        }}
      />

      <View style={[clip, { left: half }]}>
        <View style={[arc, { left: -half, transform: [{ rotate: `${angle <= 180 ? angle - 135 : 45}deg` }] }]} />
      </View>

      {angle > 180 && (
        <View style={[clip, { left: 0 }]}>
          <View style={[arc, { left: 0, transform: [{ rotate: `${angle - 135}deg` }] }]} />
        </View>
      )}

      {children}
    </View>
  );
}

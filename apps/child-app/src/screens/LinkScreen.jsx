import { useState } from 'react';
import {
  Alert, KeyboardAvoidingView, Platform, ScrollView, StatusBar, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Icon from '../components/Icon';
import { Button } from '../components/ui';
import { device as deviceApi, API_HOST } from '../services/api';
import { saveLink } from '../services/link';
import { colors, radius, space, type } from '../theme';

/**
 * The first screen a child ever sees: eight characters from their parent's app.
 *
 * It has no menu and no tab bar on purpose — nothing here is a place to go, and
 * offering navigation before the device is linked only leads to dead ends.
 */
export default function LinkScreen({ navigation, route }) {
  const insets = useSafeAreaInsets();
  /**
   * Prefilled when the screen was opened by a deep link carrying the code —
   * `com.parentix.child://link/ABC12345`, which is what a parent can send
   * instead of reading eight characters down the phone.
   *
   * Only the initial value: it is deliberately not an effect that keeps the box
   * in step with the URL, because that would overwrite what a child had started
   * typing if the same link were opened twice. Normalised the way `handleLink`
   * normalises typed input, so a lowercase link behaves like a lowercase entry.
   */
  const [code, setCode] = useState(() => (route?.params?.code || '').trim().toUpperCase());
  const [loading, setLoading] = useState(false);

  const handleLink = async () => {
    // Pasted codes routinely arrive with surrounding whitespace, which would
    // otherwise fail the length check before the code was ever tried.
    const entered = code.trim().toUpperCase();
    if (entered.length !== 8) {
      return Alert.alert('Check the code', 'Enter the 8-character code from the parent app.');
    }
    setLoading(true);

    // The request and the storage that follows it fail in different ways and
    // must not share a catch. Confirming the code marks the device linked on
    // the server, so once that call returns there is no such thing as "linking
    // failed" — only "linked, but this device could not keep its credentials".
    // Reporting both as one error hid a successful link behind a generic
    // message, and the code cannot be reused to try again.
    let res;
    try {
      res = await deviceApi.confirmLink(entered);
    } catch (err) {
      setLoading(false);

      // No response at all means the request never completed — no internet, no
      // DNS, or a TLS failure. Saying so beats a message about linking, which
      // sends people looking at the code they just typed.
      if (!err.response) {
        return Alert.alert(
          'Could not link',
          'Could not reach Parentix. Check this device\'s internet connection and try again.'
        );
      }

      /**
       * The server's "Invalid linking code" is accurate and useless.
       *
       * It is a 404 — this code is not in the database — which from the child's
       * side has exactly three causes: a typo, a code that has been superseded,
       * and the one that keeps happening, typing the greyed-out example that
       * used to sit in the box. The bare sentence named none of them, so the
       * only move it suggested was to type the same thing again. The wording
       * here says what to do; the server's message is left alone because other
       * clients read it too.
       */
      /**
       * "Try again later" when the server said exactly how much later.
       *
       * A 429 carries `Retry-After` in seconds, and this threw it away — so the
       * one question the message raises ("later" being how long?) had an answer
       * sitting in the response the whole time. Without it the only available
       * move is to keep tapping, which is the one thing that cannot help, and on
       * some limiter settings keeps the window from ever draining.
       */
      if (err.response.status === 429) {
        const seconds = Number(err.response.headers?.['retry-after']);
        // Exactly 60 rounds to 1 and read "1 minutes". A missing, zero or
        // unparseable header falls back rather than saying "NaN minutes".
        const minutes = Math.ceil(seconds / 60);
        const wait = Number.isFinite(seconds) && seconds > 0
          ? `Try again in about ${seconds < 60
            ? `${seconds} seconds`
            : `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`}.`
          : 'Try again in a few minutes.';
        return Alert.alert(
          'Too many attempts',
          `This phone has tried too many codes in a short time. ${wait} `
            + 'Ask your parent for a fresh code before trying again.'
        );
      }

      if (err.response.status === 404) {
        return Alert.alert(
          'That code was not recognised',
          // Three causes, not one. It led with the typo because that used to be
          // the only one a 404 could mean; a code is now cleared the moment it
          // is redeemed, and re-issuing one for the same device replaces it, so
          // "this code was real and is finished" arrives here too. Blaming the
          // typing was the one suggestion that cannot help in either of those.
          'This code is unknown to the server. It may have a typo, it may already have been '
            + 'used, or your parent may have generated a newer one since. Ask them for the code '
            + 'their Parentix app is showing right now — codes last 30 minutes.\n\n'
            // Named here because this is the failure it causes. A code lives in
            // one server's database, so if the parent's app is signed in to a
            // different deployment the code is real and this server has still
            // never heard of it — indistinguishable from a typo without this line.
            + `This phone is linking through ${API_HOST}.`
        );
      }

      /**
       * The code is real and the link cannot be granted: the device was removed
       * from the parent's account (410), or the account itself is not active
       * (403). Both used to succeed and hand this phone a token that failed on
       * every call it ever made, so there was nothing to word. The server's
       * sentence says which one it is and what to do about it; the title only
       * has to stop it reading as a typo.
       */
      if (err.response.status === 410 || err.response.status === 403) {
        return Alert.alert(
          'That code is no longer usable',
          err.response.data?.error
            || 'Ask your parent to add this device again and send a new code.'
        );
      }

      return Alert.alert(
        'Could not link',
        err.response.data?.error ||
          'Could not reach Parentix. Check this device\'s internet connection and try again.'
      );
    }

    const { device, deviceToken } = res.data;

    try {
      await saveLink({ deviceToken, deviceId: device.id, childId: device.childId });
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
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <StatusBar barStyle="light-content" backgroundColor={colors.teal700} />

      {/*
        Scrollable, because the keyboard on this screen covers the very field it
        is there to fill.

        The activity is `adjustResize`, so opening the keyboard shrinks the
        window to roughly 40% of its height. The hero is not a flex child and
        keeps its full intrinsic height regardless, so the sheet below it was
        left with about 170px — enough to draw "STEP 1 OF 2" and "Enter your
        code" and nothing else. The code field, the Link button and the hint
        were all laid out underneath the keyboard, clipped, with no scroll view
        to reach them: a child tapped the box, the keyboard came up, and from
        that moment they were typing somewhere they could not see.

        `flexGrow: 1` on the content (rather than a fixed height) keeps the sheet
        filling the screen when the keyboard is closed, and lets it overflow into
        a scroll when it is open. React Native scrolls the focused input into
        view on resize, so the field follows the keyboard up on its own.
      */}
      <ScrollView
        style={styles.root}
        contentContainerStyle={styles.scrollContent}
        /*
         * Without this the first tap on "Link this phone" is swallowed as a
         * dismiss-the-keyboard gesture and the child has to tap it twice — the
         * next thing they would have hit after being able to see the field again.
         */
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
      <View style={[styles.hero, { paddingTop: insets.top + space.xxl }]}>
        <View style={styles.mark}>
          <Icon name="shieldOutline" size={38} color={colors.white} />
        </View>
        <Text style={styles.heroTitle}>Parentix</Text>
        <Text style={styles.heroText}>
          Let&apos;s connect this phone to your parent&apos;s app.
        </Text>
      </View>

      <View style={[styles.sheet, { paddingBottom: insets.bottom + space.xl }]}>
        <Text style={type.eyebrow}>STEP 1 OF 2</Text>
        <Text style={[type.display, { marginTop: 4 }]}>Enter your code</Text>
        <Text style={[type.small, { marginTop: 6 }]}>
          It&apos;s 8 characters. Your parent will find it in the Parentix app, under their
          child&apos;s devices.
        </Text>

        <TextInput
          style={styles.input}
          /**
           * A mask, not an example.
           *
           * This used to read "A1B2C3D4", and a linking code is
           * `randomBytes(4).toString('hex').toUpperCase()` — eight uppercase hex
           * characters. So the hint was not merely example-shaped, it was a
           * perfectly well-formed code, drawn full-size and bold inside the very
           * box the child is asked to fill. People typed it, the server
           * correctly answered "Invalid linking code", and nothing on the screen
           * gave them any reason to suspect the thing they had copied came from
           * the app itself rather than from their parent.
           *
           * Eight dashes cannot be mistaken for content, and still show how long
           * the code is.
           */
          placeholder="––––––––"
          placeholderTextColor={colors.teal200}
          value={code}
          onChangeText={setCode}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={8}
          accessibilityLabel="Linking code"
          returnKeyType="done"
          onSubmitEditing={handleLink}
        />

        <Button
          title={loading ? 'Linking…' : 'Link this phone'}
          icon={loading ? undefined : 'check'}
          onPress={handleLink}
          disabled={loading}
        />

        <View style={styles.hint}>
          <Icon name="help" size={16} color={colors.teal600} />
          <Text style={[type.caption, { flex: 1 }]}>
            Codes expire, so ask for a new one if this says the code is invalid.
          </Text>
        </View>

        {/*
          The server this build is pinned to, stated plainly on the one screen
          where it decides whether anything works. A linking code only exists in
          one database; if the parent's app is on another deployment the code is
          valid and this phone still cannot find it. Showing the host is what
          makes those two situations tellable apart at a glance instead of
          looking like a bad code.
        */}
        <Text style={[type.caption, styles.host]}>Linking through {API_HOST}</Text>
      </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.teal700 },
  // The scrolling content still fills the screen when there is room for it —
  // without flexGrow the sheet would collapse to its content height and leave
  // teal showing under it.
  scrollContent: { flexGrow: 1 },
  hero: { paddingHorizontal: space.xl, paddingBottom: space.xxl, alignItems: 'center' },
  mark: {
    width: 82, height: 82, borderRadius: 41,
    backgroundColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: space.lg,
  },
  heroTitle: { fontSize: 30, fontWeight: '800', color: colors.white, letterSpacing: -0.5 },
  heroText: {
    fontSize: 14.5, fontWeight: '500', color: colors.teal100,
    textAlign: 'center', marginTop: 6, maxWidth: 280,
  },

  sheet: {
    // flexGrow rather than flex: inside a scroll view `flex: 1` pins the sheet
    // to the leftover space and clips whatever does not fit, which is the bug
    // this screen had. Growing lets it fill a roomy screen and take its content
    // height — scrolling — on a squeezed one.
    flexGrow: 1,
    backgroundColor: colors.canvas,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    paddingHorizontal: space.xl,
    paddingTop: space.xxl,
    gap: space.lg,
  },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 2,
    borderColor: colors.teal100,
    paddingVertical: space.lg,
    fontSize: 26,
    fontWeight: '800',
    letterSpacing: 8,
    textAlign: 'center',
    color: colors.teal800,
  },
  hint: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  // Deliberately quiet: it is diagnostic, not something a child needs to read.
  host: { textAlign: 'center', opacity: 0.55, marginTop: -space.sm },
});

import { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { CommonActions, NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import LinkScreen from './src/screens/LinkScreen';
import PermissionsScreen from './src/screens/PermissionsScreen';
import HomeScreen from './src/screens/HomeScreen';
import MessagesScreen from './src/screens/MessagesScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import { hasLink, onUnlinked } from './src/services/link';
import { stopMonitoring } from './src/services/monitoring';
import { startPushHandling, stopPushHandling } from './src/services/push';

const Stack = createStackNavigator();

/** Notification type → the screen tapping it should open. */
const SCREEN_FOR = {
  chat: 'Messages',
};

/**
 * Deep links, and the reason they are built per-state rather than declared once.
 *
 * `com.parentix.child://` is registered on both platforms — by hand in
 * AndroidManifest.xml, and by `scheme` in app.json for the iOS project EAS
 * prebuilds. Until now nothing consumed it on either: the Android intent filter
 * had been there all along and the app simply opened on whatever screen it would
 * have opened on anyway.
 *
 * The gate is what makes this more than a screens map. Every screen except
 * `Link` assumes a linked device with credentials in the keystore — `Home` reads
 * monitoring state, `Messages` opens a socket — so a link arriving at an
 * unlinked phone must not be allowed to land on one. When there is no link,
 * every path collapses to the Link screen, which is both the only screen that
 * works and the only one worth showing.
 *
 * `link/:code?` is the one that earns its keep: `com.parentix.child://link/ABC12345`
 * prefills the eight characters the parent is reading out. The QR the API used to
 * mint was removed because nothing could scan it without adding a camera
 * permission to a monitoring app — a link needs no camera and no new permission.
 */
const linkingFor = (linked) => ({
  prefixes: ['com.parentix.child://', 'https://app.parentix.ca'],
  config: {
    screens: linked
      ? {
        Link: 'link/:code?',
        Home: 'home',
        Messages: 'messages',
        Settings: 'settings',
        Permissions: 'permissions',
      }
      /**
       * Unlinked: only the Link screen is reachable, and no wildcard is needed
       * to enforce it. A path that matches nothing does not navigate at all —
       * React Navigation leaves the app on `initialRouteName`, which is `Link`
       * in exactly this state. A `'*'` here would be worse than redundant: it
       * would swallow `link/ABC12345` as an unnamed wildcard param and lose the
       * code that is the only reason the link was sent.
       */
      : { Link: 'link/:code?' },
  },
});

export default function App() {
  const [initialRoute, setInitialRoute] = useState(null);
  const navigationRef = useRef(null);
  /** A tap that arrived before the navigator existed, replayed once it does. */
  const pendingRoute = useRef(null);

  useEffect(() => {
    // If the keystore cannot be read there is no usable session, so start at
    // linking. Leaving this unhandled left the app on a blank screen forever.
    hasLink()
      .catch(() => false)
      .then((linked) => setInitialRoute(linked ? 'Home' : 'Link'));
  }, []);

  /**
   * The parent removed this device.
   *
   * Discovered by the socket while the app is open, or by the first API call
   * that answers 401 after it wakes up; either way `services/link.js` has
   * already discarded the credentials by the time this runs. What is left is the
   * part only the shell can do — stop the monitors, tear the stack down to the
   * link screen, and say what happened, because a phone that silently stopped
   * enforcing rules and lost its Home screen needs one sentence of explanation
   * more than it needs anything else.
   */
  useEffect(() => onUnlinked(() => {
    stopMonitoring();
    navigationRef.current?.dispatch(
      CommonActions.reset({ index: 0, routes: [{ name: 'Link' }] })
    );
    Alert.alert(
      'This phone was unlinked',
      'Your parent removed this device from their Parentix app. Ask them for a new code if it '
        + 'should be connected again.'
    );
  }), []);

  useEffect(() => {
    const openFromNotification = (data) => {
      const screen = data?.screen || SCREEN_FOR[data?.type];
      if (!screen) return;
      // A notification the child tapped to launch the app from cold is delivered
      // before the navigator is ready; hold it rather than dropping it.
      if (navigationRef.current?.isReady()) navigationRef.current.navigate(screen);
      else pendingRoute.current = screen;
    };

    startPushHandling({ onOpen: openFromNotification });
    return stopPushHandling;
  }, []);

  if (!initialRoute) return null;

  return (
    // Every screen sizes itself around the notch and the gesture bar, and the
    // insets have to come from somewhere above the navigator to be available to
    // the shell as well as to the screens inside it.
    <SafeAreaProvider>
      <NavigationContainer
        ref={navigationRef}
        linking={linkingFor(initialRoute !== 'Link')}
        onReady={() => {
          if (pendingRoute.current) {
            navigationRef.current?.navigate(pendingRoute.current);
            pendingRoute.current = null;
          }
        }}
      >
        <Stack.Navigator screenOptions={{ headerShown: false }} initialRouteName={initialRoute}>
          <Stack.Screen name="Link" component={LinkScreen} />
          <Stack.Screen name="Permissions" component={PermissionsScreen} />
          <Stack.Screen name="Home" component={HomeScreen} />
          <Stack.Screen name="Messages" component={MessagesScreen} />
          <Stack.Screen name="Settings" component={SettingsScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

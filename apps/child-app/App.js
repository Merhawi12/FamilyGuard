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

import UIKit
import Capacitor
import FirebaseCore
import FirebaseMessaging

/**
 Push on iOS, and why this file is not Capacitor's stock template.

 The server speaks three push transports — `web`, `fcm` and `expo`
 (services/api/src/utils/pushService.js) — and APNs is deliberately not one of
 them. Adding a fourth would mean a second credential to rotate, a second
 delivery path to debug and a second set of failure modes, for an app that
 already has a working one. So iOS registers with **FCM**, which delivers to
 Apple devices by talking to APNs itself, and the token this app sends up is an
 FCM registration token exactly like the Android build's. `push.js` can go on
 calling `pushSubscribe(token, label, 'fcm')` on both platforms, and no server
 change was needed to support iOS at all.

 That arrangement is what the two `didRegister…` methods below exist for.
 `@capacitor/push-notifications` on iOS reports the **APNs** token by default,
 which FCM cannot deliver to and the server would store as a permanently dead
 subscription. The documented integration is to intercept the APNs token, hand
 it to Firebase, ask Firebase for the FCM token that corresponds to it, and post
 *that* to the notification Capacitor is listening on — which is precisely the
 sequence below.

 Nothing here is reachable from the WebView; `push.js` is unchanged on iOS.
 */
@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    /**
     Whether Firebase started, which is not the same as whether it was asked to.

     `FirebaseApp.configure()` raises if `GoogleService-Info.plist` is not in the
     bundle, and that file is deliberately not committed (see .gitignore) — it
     belongs to whichever Firebase project a build targets. A developer who
     clones this repo and builds would otherwise get a crash on launch rather
     than an app with push switched off, which is the wrong failure for a
     feature that is not the one they are working on.

     The Android build already degrades this way: `apps/family-app/android/app/
     build.gradle` applies the google-services plugin only when the file exists.
     This is the same behaviour, made explicit.
     */
    private var firebaseConfigured = false

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        if Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil {
            FirebaseApp.configure()
            firebaseConfigured = true
        } else {
            // Deliberately not fatal, and deliberately loud. Push is the only
            // thing affected, and the Settings screen will report it as
            // unavailable once registration fails below.
            NSLog("[Parentix] GoogleService-Info.plist is missing — push notifications are disabled in this build. See docs/DEPLOYMENT.md §2.3c.")
        }
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
    }

    func applicationWillTerminate(_ application: UIApplication) {
    }

    // MARK: - Remote notification registration

    /**
     APNs has issued a device token. Trade it for an FCM one.

     Capacitor's plugin listens on `.capacitorDidRegisterForRemoteNotifications`
     and accepts either `Data` (which it hex-encodes, the APNs case) or `String`
     (which it passes through). Posting the FCM token as a `String` is what makes
     the `registration` event in push.js carry a token the server can actually
     deliver to.

     Firebase needs `apnsToken` set before `token(completion:)` is asked, or it
     answers with an error on a real device — the FCM token is derived from the
     APNs one.
     */
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        guard firebaseConfigured else {
            /**
             Reported as a failure rather than passing the APNs token through.

             Handing the raw APNs token to the server as platform `fcm` would be
             accepted, stored, and silently never delivered to — a subscription
             that looks healthy on the Settings screen and is dead. An honest
             error is what lets the parent see that notifications are not on.
             */
            NotificationCenter.default.post(
                name: .capacitorDidFailToRegisterForRemoteNotifications,
                object: NSError(
                    domain: "ca.parentix.family",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Push is not configured in this build (GoogleService-Info.plist is missing)."]
                )
            )
            return
        }

        Messaging.messaging().apnsToken = deviceToken
        Messaging.messaging().token { token, error in
            if let token = token {
                NotificationCenter.default.post(
                    name: .capacitorDidRegisterForRemoteNotifications,
                    object: token
                )
            } else {
                NotificationCenter.default.post(
                    name: .capacitorDidFailToRegisterForRemoteNotifications,
                    object: error ?? NSError(
                        domain: "ca.parentix.family",
                        code: 2,
                        userInfo: [NSLocalizedDescriptionKey: "Firebase returned no FCM token."]
                    )
                )
            }
        }
    }

    /**
     Registration failed outright — no network at first launch, a build signed
     without the push entitlement, or a Simulator older than iOS 16 (which has no
     APNs at all). Forwarded so `awaitNativeToken` in push.js rejects with a
     reason instead of hanging on a promise that never settles.
     */
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(
            name: .capacitorDidFailToRegisterForRemoteNotifications,
            object: error
        )
    }

    // MARK: - Capacitor URL handling

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}

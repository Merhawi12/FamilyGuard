package ca.parentix.family;

import android.content.Context;

import androidx.core.content.ContextCompat;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.credentials.exceptions.NoCredentialException;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;

/**
 * Sign in with Google, natively.
 *
 * The web app asks Google Identity Services for an ID token in the browser. That
 * cannot happen here: Google refuses OAuth inside an embedded WebView, which is
 * their policy and not a bug to route around, so in the APK the script does not
 * load and the button never appears. This plugin is the other half of the same
 * contract — it obtains the *same artefact*, an ID token signed by Google, from
 * Play Services instead of from a page, and hands it to the same
 * `POST /api/auth/google` for the same verification.
 *
 * Nothing here decides anything about the account. The token's signature,
 * issuer, expiry and audience are all checked on the server; a token this class
 * returns is a claim, not a session.
 *
 * ## Credential Manager, not GoogleSignInClient
 *
 * `com.google.android.gms.auth.api.signin.GoogleSignIn` — what most Capacitor
 * Google plugins still wrap — was deprecated by Google in 2024 and is on a
 * removal path. `androidx.credentials` is the replacement and is what new
 * integrations are expected to use, so it is what this one uses.
 *
 * `GetSignInWithGoogleOption` rather than `GetGoogleIdOption`, because this runs
 * from a button press: it always shows the account chooser, including the option
 * to add an account. `GetGoogleIdOption` is the "one tap on an account already
 * on the device" variant, which fails outright on a handset that has none —
 * exactly the phone whose owner is trying to *create* an account.
 */
@CapacitorPlugin(name = "GoogleAuth")
public class GoogleAuthPlugin extends Plugin {

    /**
     * Whether this build can complete a Google sign-in at all.
     *
     * Asked by the JavaScript before it draws anything, because a button that
     * fails on tap is worse than no button — the same rule the web component
     * applies to a missing client ID. Two ways it cannot work, and they are
     * different situations rather than degrees of the same one:
     *
     *   no-client-id      nothing told this build which server to mint tokens
     *                     for. A configuration state, on every device.
     *   no-play-services  this particular handset has no Google Play Services
     *                     backing Credential Manager. Nothing is misconfigured;
     *                     the phone simply cannot do it, and the parent should
     *                     be shown the email form instead.
     */
    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        String reason = "";

        if (serverClientId(call.getString("clientId")).isEmpty()) {
            reason = "no-client-id";
        } else if (!hasPlayServices(getContext())) {
            reason = "no-play-services";
        }

        result.put("available", reason.isEmpty());
        // Carried back so a developer looking at a missing button can tell the
        // two apart without a debugger. The UI never renders it.
        result.put("reason", reason);
        call.resolve(result);
    }

    /**
     * Opens the account chooser and resolves with the ID token it produces.
     *
     * Rejection codes matter to the caller and are part of this method's
     * contract: `cancelled` is somebody changing their mind and must leave no
     * error on the screen, while everything else is a failure worth a sentence.
     */
    @PluginMethod
    public void signIn(PluginCall call) {
        final String clientId = serverClientId(call.getString("clientId"));
        if (clientId.isEmpty()) {
            call.reject("No Google server client ID is configured for this build.", "no-client-id");
            return;
        }
        if (!hasPlayServices(getContext())) {
            call.reject("Google Play Services is not available on this device.", "no-play-services");
            return;
        }

        GetSignInWithGoogleOption option = new GetSignInWithGoogleOption.Builder(clientId).build();
        GetCredentialRequest request = new GetCredentialRequest.Builder()
            .addCredentialOption(option)
            .build();

        CredentialManager credentialManager = CredentialManager.create(getContext());

        /*
         * Run on the UI thread: Capacitor dispatches plugin calls on a
         * background thread, and this call ends in an activity being launched
         * over ours.
         */
        getActivity().runOnUiThread(() -> credentialManager.getCredentialAsync(
            // The activity, deliberately, not the application context — the
            // chooser is drawn on top of this screen.
            getActivity(),
            request,
            null,
            ContextCompat.getMainExecutor(getContext()),
            new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                @Override
                public void onResult(GetCredentialResponse response) {
                    handleCredential(call, response.getCredential());
                }

                @Override
                public void onError(GetCredentialException error) {
                    if (error instanceof GetCredentialCancellationException) {
                        call.reject("Sign-in cancelled", "cancelled");
                    } else if (error instanceof NoCredentialException) {
                        // Not a fault: the chooser closed with nothing chosen,
                        // usually because there is no Google account on the
                        // device and the person declined to add one.
                        call.reject("No Google account was chosen.", "no-credential");
                    } else {
                        /*
                         * The one that will be met most often during setup:
                         * Play Services answers with a developer error when no
                         * Android OAuth client matches this package name and
                         * signing certificate. The message is passed through
                         * because it is the only place that says so.
                         */
                        call.reject(error.getMessage(), "failed", error);
                    }
                }
            }
        ));
    }

    /**
     * Unwraps the ID token, and refuses anything else.
     *
     * Credential Manager is a general credential API — it can return a
     * passkey or a saved password — so the type is checked rather than assumed.
     * Only a Google ID token is any use to `POST /api/auth/google`.
     */
    private void handleCredential(PluginCall call, Credential credential) {
        if (!(credential instanceof CustomCredential)
            || !GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(credential.getType())) {
            call.reject("Google returned an unexpected credential type.", "failed");
            return;
        }

        try {
            GoogleIdTokenCredential googleCredential =
                GoogleIdTokenCredential.createFrom(((CustomCredential) credential).getData());

            JSObject result = new JSObject();
            // The only field that is acted on. Everything below it is for the
            // screen to show while the API answers; the account the session
            // belongs to is decided from the token, on the server.
            result.put("idToken", googleCredential.getIdToken());
            result.put("email", googleCredential.getId());
            result.put("name", googleCredential.getDisplayName());
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Could not read the Google credential.", "failed", e);
        }
    }

    /**
     * Which OAuth client the token should be minted for.
     *
     * This is the *web* client ID even though the caller is an Android app, and
     * that is not a mistake to be tidied up later: the Android OAuth client
     * identifies the app to Play Services by package name and signing
     * certificate, while the ID token's `aud` — what the API verifies — is the
     * web client. Both must exist, and only one of them is named here.
     *
     * Three sources, most specific first:
     *
     *   1. whatever JavaScript passed in, so a build can be pointed at another
     *      client without a native change;
     *   2. `@string/server_client_id`, for an override baked into the app;
     *   3. `@string/default_web_client_id`, which the google-services Gradle
     *      plugin generates from `google-services.json` — so an app already set
     *      up for FCM needs no second piece of configuration.
     *
     * Resolved by name rather than through `R.string`, because both of those
     * resources may legitimately not exist: `app/build.gradle` applies the
     * google-services plugin only when the JSON file is present, and a direct
     * `R.string.default_web_client_id` would then stop the app compiling at all.
     */
    private String serverClientId(String fromCall) {
        if (fromCall != null && !fromCall.trim().isEmpty()) return fromCall.trim();

        String override = stringResource("server_client_id");
        if (!override.isEmpty()) return override;

        return stringResource("default_web_client_id");
    }

    private String stringResource(String name) {
        Context context = getContext();
        @SuppressWarnings("DiscouragedApi")
        int id = context.getResources().getIdentifier(name, "string", context.getPackageName());
        if (id == 0) return "";
        String value = context.getString(id);
        return value == null ? "" : value.trim();
    }

    private static boolean hasPlayServices(Context context) {
        return GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context)
            == ConnectionResult.SUCCESS;
    }
}

# Stripe integration — remaining steps

The Checkout Studio configuration has been applied to the existing Checkout
Session call. This file is the single source of truth for what is left.

**File changed:** [services/api/src/routes/payments.js](services/api/src/routes/payments.js)

## Values to replace

Every `sample_only` parameter already held a real value and was kept, so there
are **no placeholders in the code**. What is missing is credentials, and they do
not live in the code at all — the API reads them from the environment, and
production reads them from Secret Manager.

| Field | Where | Current | What to set |
|-------|-------|---------|-------------|
| `STRIPE_SECRET_KEY` | [services/api/.env](services/api/.env) | a **publishable** key (`pk_live_…`) | The secret key from Developers → API keys → *Secret key* (`sk_live_…`), or a restricted key (`rk_live_…`) with write on Checkout Sessions, Customers, Subscriptions and Billing Portal. |
| `STRIPE_PREMIUM_PRICE_ID` | [services/api/.env](services/api/.env) | the same publishable key | Products → Premium → the price → *API ID* (`price_…`). Must be a **recurring monthly** price, or `mode: 'subscription'` is rejected. |
| `STRIPE_WEBHOOK_SECRET` | [services/api/.env](services/api/.env) | a real `whsec_…`, but **exposed in a terminal** | Roll it (Developers → Webhooks → your endpoint → *Roll secret*) and store the new one. |
| `STRIPE_FAMILY_PRICE_ID` | [services/api/.env](services/api/.env) | `price_REPLACE_…` | Leave **empty**. It exists only to map grandfathered Family Plus subscriptions; a leftover placeholder is worse than nothing. |

A value of the wrong kind is read as absent and named in the boot log — see
`stripeValue` in [services/api/src/config/env.js](services/api/src/config/env.js).

## Configured parameters

Set in Checkout Studio and now sent on every session. Change them there, not
here.

**File containing them:** [services/api/src/routes/payments.js](services/api/src/routes/payments.js)

| Parameter | Value |
|-----------|-------|
| `billing_address_collection` | `auto` |
| `phone_number_collection` | `{ enabled: false }` |
| `automatic_tax` | `{ enabled: false }` |
| `allow_promotion_codes` | `false` |
| `payment_method_collection` | `always` |

### Four Studio parameters were applied and then removed

`ui_mode: 'hosted_page'`, `submit_type: 'auto'`,
`integration_identifier: 'hosted_mobile_app_0001'` and
`origin_context: 'mobile_app'` are **not sent**. Checkout began answering
*"Payments are not set up correctly on this deployment"* the moment they were
added.

They are the four that depend on how new the **account's default API version**
is — this client pins no version, deliberately — and Stripe refuses a parameter
it does not recognise rather than ignoring it. `submit_type` carries a second
constraint: it has historically been accepted only with `mode: 'payment'`, and
every session here is a subscription.

Nothing visible is lost. `hosted` is what `ui_mode` defaults to, `auto` is the
default submit wording, and the other two are attribution labels.
`origin_context: 'mobile_app'` was also untrue: this session is created for a
parent on the web dashboard, and the Android build is that same page in a
WebView.

**To put them back**, pin an API version that accepts them —
`Stripe(key, { apiVersion: '…' })` in
[services/api/src/services/billing.js](services/api/src/services/billing.js) —
and re-add them one at a time.
[services/api/tests/payments.test.js](services/api/tests/payments.test.js) pins
their absence, so a paste-back is a failing test rather than a broken checkout.

### What was deliberately *not* removed

The task says to remove parameters absent from the configuration. Two were kept,
because removing them breaks fulfilment rather than the payment page:

- **`customer`** — ties the subscription to the Stripe customer this service
  stores.
- **`metadata: { userId, plan }`** — how `checkout.session.completed` attributes
  a payment to an account.

Without them a customer whose card was charged stays on the free plan, and the
only trace is a log line asking an operator to reconcile it. The webhook's own
attribution comment records that this has happened before. Both are pinned by
`sends the attribution the webhook needs to credit the payment` in
[services/api/tests/payments.test.js](services/api/tests/payments.test.js).

**`payment_method_types: ['card']` was removed.** Pinning it overrides the
payment methods enabled on the Stripe account, so switching one on in the
dashboard would have done nothing.

## If checkout still refuses

Restart the API and rebuild the web bundle first — outside production the banner
now appends Stripe's own wording, which names the fault directly:

```
Payments are not set up correctly on this deployment. Please contact support.
  (StripePermissionError: The provided key does not have the required permissions.)
```

The server log carries the same thing on every attempt, whatever the browser is
running:

```bash
grep -A2 'Stripe request failed' <api log>          # local
gcloud run services logs read parentix-prod-api --region us-central1 --limit 50 \
  | grep -B2 -A2 'Stripe request failed'            # Cloud Run
```

What the `type` means:

| `type` | Cause | Fix |
|--------|-------|-----|
| `StripePermissionError` | A restricted key missing a scope | Add write on Checkout Sessions, Customers, Subscriptions, Billing Portal — or use the plain `sk_` key |
| `StripeInvalidRequestError: No such price` | The price belongs to another account, or is a test-mode price against a live key | Re-copy the API ID from the price in the matching mode |
| `StripeInvalidRequestError: Received unknown parameter` | A parameter this account's API version does not know | Remove the parameter it names — see the removed four above |
| `StripeAuthenticationError` | The key is not a secret key, or was rolled | Re-copy it from Developers → API keys |
| `StripeConnectionError` | The API process cannot reach `api.stripe.com` | Network or proxy; `curl -sS -o /dev/null -w '%{http_code}\n' https://api.stripe.com/v1/` from the *same machine* should answer, not hang |

## Setup

1. Put the three real values in [services/api/.env](services/api/.env) (see the
   table above) and restart the API.
2. Register the webhook endpoint in the Stripe dashboard:

   ```
   https://api.parentix.ca/api/payments/webhook
   ```

   with exactly the five events the handler implements:
   `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.

3. For production, the same three values go into Secret Manager, not `.env`:

   ```bash
   read -rs KEY && printf '%s' "$KEY" | gcloud secrets versions add parentix-prod-stripe-secret-key --data-file=- && unset KEY
   read -rs WH  && printf '%s' "$WH"  | gcloud secrets versions add parentix-prod-stripe-webhook-secret --data-file=- && unset WH
   printf '%s' 'price_…' | gcloud secrets versions add parentix-prod-stripe-premium-price-id --data-file=-
   ```

   `read -rs` keeps the credential out of shell history. Cloud Run resolves
   `version = "latest"` when a container starts, so a new revision is needed
   before it is read.

## How it works

1. The plan screen calls `POST /api/payments/create-checkout-session`.
2. The API creates or reuses a Stripe customer, creates the Checkout Session
   with the parameters above, and returns its URL.
3. The browser is redirected to Stripe's hosted page.
4. On success Stripe returns the customer to
   `/dashboard/settings?payment=success` — on `app.parentix.ca`, since
   `CLIENT_URL` leads with that host.
5. **The plan changes on the webhook, not on the redirect.** A customer can pay
   and close the tab; `checkout.session.completed` is what grants Premium. A
   wrong signing secret means every event is rejected 400 and no one is ever
   upgraded, while checkout itself looks perfect.

## Testing

Use **test mode** first: `sk_test_…` with a `price_…` created in test mode, and
card `4242 4242 4242 4242`, any future expiry, any CVC. Live keys charge real
cards on the first completed session.

`stripe listen --forward-to localhost:5000/api/payments/webhook` replays events
at a local API and prints a `whsec_…` for that session.

## Proven end to end in test mode — 2026-08-30

The whole loop has now been driven with a real card, so the half that fails
silently is no longer unverified **locally**. What was exercised: the real
`POST /create-checkout-session`, Stripe's hosted page paid with
`4242 4242 4242 4242` in a real browser, the completed session read back from
Stripe, and that object posted to the real webhook route under a genuine
signature from `stripe.webhooks.generateTestHeaderString`. 14 checks, including
a wrongly-signed event rejected 400, the account flipping to Premium, and a
redelivered event being safe to replay.

Two things worth keeping from it:

- **The Stripe *test* account was empty** — no product, no price. There was
  nothing to put in `STRIPE_PREMIUM_PRICE_ID`; the Premium product exists in live
  mode only. `price_1UABKc51GqmqoE3ox21NlqAv` (Premium Plan, CAD 9.99/month) was
  created to match `config/plans.js` (`amount: 999`) in the account's default
  currency.
- **Checkout renders a payment-method accordion, not an inline card form**,
  because more than one method is enabled on the account and this route
  deliberately does not pin `payment_method_types`. Card fields do not exist
  until the Card tab is clicked. That is correct behaviour — but any browser
  automation against this page has to click the tab first, or it submits into
  "PAYMENT METHOD REQUIRED".

No Stripe CLI is needed for any of this; `generateTestHeaderString` signs a real
envelope, which is what `stripe listen` would otherwise be for.

## Next steps

- **Production is a different Stripe account from the local test key.** That
  account held no price at all until the one above was created, so no session
  for this product could ever have been created against it — do **not** copy
  `price_1UABKc51GqmqoE3ox21NlqAv` into Secret Manager. Audit what production
  really holds with `ENV_NAME=prod ./scripts/check-stripe.sh` (needs an
  interactive `gcloud auth login` first), and repeat the purchase test there.
- Retire the exposed webhook secret's Secret Manager version after rolling it:
  `gcloud secrets versions destroy <N> --secret=parentix-prod-stripe-webhook-secret`.

## Resources

- https://docs.stripe.com/mcp
- https://support.stripe.com

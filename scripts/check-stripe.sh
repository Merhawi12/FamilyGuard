#!/usr/bin/env bash
#
# Audits the Stripe configuration a deployment is actually running, cleans up
# versions that were stored by mistake, and proves the result against Stripe.
#
#   ./scripts/check-stripe.sh                 # audit only, changes nothing
#   ./scripts/check-stripe.sh --clean         # also destroy junk versions
#   ./scripts/check-stripe.sh --clean --roll  # …and roll a revision to pick them up
#
# ## Why this exists
#
# Every Stripe outage on this platform has been a value of the wrong *kind*
# sitting in the right place, and none of them announced itself:
#
#   - a publishable key (`pk_live_`) in STRIPE_SECRET_KEY, which authenticates
#     nothing and made `/auth/providers` advertise billing anyway;
#   - the same publishable key pasted into STRIPE_PREMIUM_PRICE_ID;
#   - a whole shell command captured as a secret, because `read -rs KEY && …`
#     was pasted as two lines and `read` consumed the second one as its input;
#   - a spaced Gmail app password, which is the same class of fault one service
#     over.
#
# Secret Manager stores any bytes you hand it, Cloud Run mounts them without
# looking, and the failure appears much later as a 503 under an Upgrade button.
# This reads what is really stored, one version at a time, and says which of
# them could not possibly work.
#
# ## What it never does
#
# It never prints a secret. Values are reported as a length and a prefix, which
# is enough to tell `price_1ABC…` from a pasted command and not enough to be
# worth redacting out of a terminal afterwards. It never destroys the version a
# deployment is currently reading, and it refuses to destroy anything at all
# while the newest version is itself junk — that combination is how you end up
# with a secret that has no usable version left.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_tool gcloud
require_tool curl
require_gcloud_auth
require_project

REGION="${REGION:-us-central1}"
SERVICE="parentix-${ENV_NAME}-api"

CLEAN=0
ROLL=0
LIST=0
SET_PRICE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --clean) CLEAN=1; shift ;;
    --roll)  ROLL=1;  shift ;;
    --list-prices) LIST=1; shift ;;
    --set-price) SET_PRICE=1; shift ;;
    -h|--help) sed -n '3,10p' "$0"; exit 0 ;;
    *) die "Unknown argument '$1'. Use --clean, --roll, --list-prices and/or --set-price." ;;
  esac
done

# ── What is actually sellable on this account ────────────────────────────────
#
# "Copy the API ID from the dashboard" is the step that keeps going wrong — it
# has produced a publishable key, and an example value out of a chat message,
# both of which look close enough to survive every offline check. The account
# already knows the answer and the key to ask with is already in Secret Manager,
# so the value can be read rather than transcribed.
#
# Only prices are printed. A price ID is not a credential — it appears in
# client-side Stripe integrations by design — and the key is unset immediately.
if [ "$SET_PRICE" = 1 ]; then
  # The transcription step, deleted.
  #
  # Copying an API ID by hand has now put a publishable key and two example
  # values into this secret. Every one of them was a person moving a string from
  # a screen into a command, and none of the offline checks could see the
  # difference. Here the ID never becomes text anybody handles: it is read from
  # the account and written to Secret Manager in the same breath.
  #
  # Only recurring prices are candidates, because checkout sells a subscription.
  # If exactly one exists it is used; if several do, PRICE_ID names which, and
  # the list is printed rather than a guess being made.
  require_tool node
  KEY="$(gcloud secrets versions access latest --secret="parentix-${ENV_NAME}-stripe-secret-key")"
  body="$(curl -sS -u "${KEY}:" 'https://api.stripe.com/v1/prices?active=true&limit=100&expand[]=data.product')"
  unset KEY

  mapfile -t candidates < <(printf '%s' "$body" | node -e '
    let raw = "";
    process.stdin.on("data", (d) => { raw += d; });
    process.stdin.on("end", () => {
      const parsed = JSON.parse(raw);
      if (parsed.error) { console.error("stripe: " + parsed.error.message); process.exit(1); }
      for (const p of (parsed.data || []).filter((x) => x.recurring)) {
        const amount = p.unit_amount == null ? "metered" : (p.unit_amount / 100).toFixed(2) + " " + p.currency.toUpperCase();
        const name = (p.product && p.product.name) || p.nickname || "";
        // id first so the shell can cut it out without parsing the rest.
        console.log([p.id, amount, p.recurring.interval, p.livemode ? "live" : "TEST", name].join("\t"));
      }
    });
  ') || die "Could not read prices from Stripe."

  [ "${#candidates[@]}" -gt 0 ] || die "No active recurring price exists on this account.
       Checkout sells a subscription, so a one-off price cannot be used.
       Create a monthly price on the Premium product in the Stripe dashboard."

  chosen=""
  if [ -n "${PRICE_ID:-}" ]; then
    for row in "${candidates[@]}"; do
      [ "${row%%$'\t'*}" = "$PRICE_ID" ] && chosen="$PRICE_ID"
    done
    [ -n "$chosen" ] || die "PRICE_ID=${PRICE_ID} is not an active recurring price on this account."
  elif [ "${#candidates[@]}" -eq 1 ]; then
    chosen="${candidates[0]%%$'\t'*}"
  else
    log "Several recurring prices exist — name one with PRICE_ID:"
    for row in "${candidates[@]}"; do printf '    %s\n' "$row" >&2; done
    die "Re-run as: PRICE_ID=<id from above> $0 --set-price"
  fi

  for row in "${candidates[@]}"; do
    [ "${row%%$'\t'*}" = "$chosen" ] && log "Storing: ${row}"
  done

  printf '%s' "$chosen" | gcloud secrets versions add \
    "parentix-${ENV_NAME}-stripe-premium-price-id" --data-file=- --quiet >/dev/null \
    || die "Could not write the secret version."
  log "Stored. Re-run with --clean --roll to tidy old versions and pick it up."
  exit 0
fi

if [ "$LIST" = 1 ]; then
  require_tool node
  KEY="$(gcloud secrets versions access latest --secret="parentix-${ENV_NAME}-stripe-secret-key")"
  body="$(curl -sS -u "${KEY}:" 'https://api.stripe.com/v1/prices?active=true&limit=100&expand[]=data.product')"
  unset KEY

  log "Active prices on this Stripe account:"
  printf '%s' "$body" | node -e '
    let raw = "";
    process.stdin.on("data", (d) => { raw += d; });
    process.stdin.on("end", () => {
      const parsed = JSON.parse(raw);
      if (parsed.error) {
        console.error("  Stripe refused: " + parsed.error.message);
        process.exit(1);
      }
      // Checkout here sells a subscription, so a one-off price cannot be used
      // even though the dashboard lists it alongside the others.
      const rows = (parsed.data || []).filter((p) => p.recurring);
      if (!rows.length) {
        console.log("  No recurring prices exist. Create a monthly price on the Premium product.");
        return;
      }
      for (const p of rows) {
        const amount = p.unit_amount == null
          ? "metered"
          : (p.unit_amount / 100).toFixed(2) + " " + p.currency.toUpperCase();
        const name = (p.product && p.product.name) || p.nickname || "";
        console.log(
          "  " + p.id.padEnd(34) + amount.padEnd(12) + "/" + p.recurring.interval
          + "  " + (p.livemode ? "live" : "TEST") + "  " + name
        );
      }
      console.log("\n  Store the one Premium sells at:");
      console.log("    printf %s <the id above> | gcloud secrets versions add "
        + "parentix-'"${ENV_NAME}"'-stripe-premium-price-id --data-file=-");
    });
  ' || die "Could not list prices."
  exit 0
fi

log "Environment : ${ENV_NAME} (${PROJECT_ID}, ${REGION})"
log "Service     : ${SERVICE}"
[ "$CLEAN" = 1 ] || warn "Audit only. Re-run with --clean to destroy the versions this flags."

# ── What each secret must look like ──────────────────────────────────────────
#
# Prefix and a plausible minimum length. The length matters as much as the
# prefix: `price_` followed by nothing is as broken as a command, and a
# truncated paste is a real failure mode.
#
# `rk_` is allowed for the secret key because a restricted key is a reasonable
# way to run this service — see STRIPE_INTEGRATION_TODO.md for the scopes it
# needs, which are the one thing this script cannot check without spending a
# request against every endpoint.
SECRETS=(
  "stripe-secret-key|sk_,rk_|20|the API key the service authenticates with"
  "stripe-premium-price-id|price_|10|the Premium price checkout sells"
  "stripe-webhook-secret|whsec_|20|proves a webhook really came from Stripe"
)

JUNK_FOUND=0
BLOCKED=0
TO_DESTROY=()

# Reads one version and classifies it, printing a length and a prefix only.
# Echoes "ok" or "junk" so the caller can decide what to do about it.
classify() {
  local secret="$1" version="$2" prefixes="$3" minlen="$4"
  local payload length head matched=0

  # Read through a file rather than a command substitution, which strips every
  # trailing newline it finds. That would make the `echo` check below dead code —
  # and a value stored with `echo` instead of `printf` is one of the two faults
  # this script exists to catch, because Secret Manager keeps that newline and
  # Stripe then sees a credential that does not exist.
  #
  # The `printf X` / `%X` pair is what preserves it: the substitution strips back
  # to the sentinel instead of into the payload.
  local tmp; tmp="$(mktemp)"
  if ! gcloud secrets versions access "$version" --secret="$secret" >"$tmp" 2>/dev/null; then
    rm -f "$tmp"
    printf '    version %-4s (could not be read — disabled or destroyed)\n' "$version" >&2
    echo unreadable
    return
  fi
  payload="$(cat "$tmp"; printf X)"
  payload="${payload%X}"
  rm -f "$tmp"

  length="${#payload}"
  head="$(printf '%s' "$payload" | cut -c1-7)"

  local IFS=,
  for p in $prefixes; do
    case "$payload" in "$p"*) matched=1 ;; esac
  done
  unset IFS

  # A trailing newline is its own bug: `echo` adds one, Secret Manager keeps it,
  # and Stripe then sees a key that does not exist. Worth naming separately,
  # because the prefix and the length both look almost right.
  local trailing=""
  case "$payload" in *$'\n') trailing=" — HAS A TRAILING NEWLINE (stored with echo instead of printf)" ;; esac

  # An example value, stored because it sat in a command somebody could paste.
  #
  # Twice now. `price_1ABCdef...` reached production out of a line in this
  # project's own instructions, and after that was caught by a blocklist of
  # placeholder spellings, `price_1Qx…` reached it the same way — the same fault
  # wearing a Unicode ellipsis instead of three dots, which the blocklist did not
  # contain. Blocklisting the shapes of wrongness is a game you lose one
  # character at a time.
  #
  # So this allowlists the alphabet instead. Every Stripe key and identifier is
  # ASCII letters, digits and underscores; an ellipsis, an angle bracket, a
  # space, a smart quote and a newline are all outside it by construction, and
  # no future placeholder can be inside it while still looking like a
  # placeholder.
  # Only when the newline check has not already explained it — a newline is
  # outside this alphabet too, and printing both reads as two separate faults.
  local placeholder=""
  if [ -z "$trailing" ]; then
    case "$payload" in
      *[!A-Za-z0-9_]*) placeholder=" — CONTAINS CHARACTERS A STRIPE ID CANNOT HAVE (an example value, or a mangled paste)" ;;
    esac
  fi

  if [ "$matched" = 1 ] && [ "$length" -ge "$minlen" ] && [ -z "$trailing" ] && [ -z "$placeholder" ]; then
    printf '    version %-4s %-6s len=%-4s ✓\n' "$version" "${head}…" "$length" >&2
    echo ok
  else
    printf '    version %-4s %-6s len=%-4s ✗%s%s\n' "$version" "${head}…" "$length" "$trailing" "$placeholder" >&2
    echo junk
  fi
}

for entry in "${SECRETS[@]}"; do
  IFS='|' read -r suffix prefixes minlen description <<< "$entry"
  name="parentix-${ENV_NAME}-${suffix}"

  echo
  log "${name} — ${description}"

  if ! gcloud secrets describe "$name" >/dev/null 2>&1; then
    warn "  No such secret. Terraform creates it; run the infrastructure apply first."
    BLOCKED=1
    continue
  fi

  # Newest first, which is the order that matters: the first enabled version is
  # what `version = "latest"` resolves to on the next container start.
  mapfile -t versions < <(
    gcloud secrets versions list "$name" --filter='state:ENABLED' \
      --sort-by=~createTime --format='value(name)' 2>/dev/null
  )

  if [ "${#versions[@]}" -eq 0 ]; then
    warn "  No enabled versions — nothing is configured."
    BLOCKED=1
    continue
  fi

  latest="${versions[0]}"
  latest_state="$(classify "$name" "$latest" "$prefixes" "$minlen" )"

  for v in "${versions[@]:1}"; do
    state="$(classify "$name" "$v" "$prefixes" "$minlen" )"
    if [ "$state" = junk ]; then
      JUNK_FOUND=1
      TO_DESTROY+=("${name}:${v}")
    fi
  done

  if [ "$latest_state" != ok ]; then
    warn "  The NEWEST version is the broken one — this is what the service reads."
    warn "  Add a correct version before cleaning anything:"
    warn "    printf '%s' '<value>' | gcloud secrets versions add ${name} --data-file=-"
    BLOCKED=1
  fi
done

# ── Prove it against Stripe ──────────────────────────────────────────────────
#
# The shapes above are necessary and nowhere near sufficient: a perfectly shaped
# key can be revoked, and a perfectly shaped price can belong to a different
# account or be a one-off rather than a subscription. Only Stripe knows. This is
# one read-only GET and it settles all of it at once — the same order
# setup-google-mail.sh uses, and for the same reason.
echo
if [ "$BLOCKED" = 1 ]; then
  warn "Skipping the live check — fix the above first."
else
  log "Asking Stripe whether the stored key can read the stored price …"

  KEY="$(gcloud secrets versions access latest --secret="parentix-${ENV_NAME}-stripe-secret-key")"
  PRICE="$(gcloud secrets versions access latest --secret="parentix-${ENV_NAME}-stripe-premium-price-id")"

  body="$(curl -sS -u "${KEY}:" "https://api.stripe.com/v1/prices/${PRICE}")"
  unset KEY

  if printf '%s' "$body" | grep -q '"error"'; then
    # Stripe's message names the key or the price, never a credential value.
    reason="$(printf '%s' "$body" | sed -n 's/.*"message": *"\([^"]*\)".*/\1/p')"
    type="$(printf '%s' "$body" | sed -n 's/.*"type": *"\([^"]*\)".*/\1/p')"
    die "Stripe refused: ${type} — ${reason}

       invalid_request_error / No such price → the price belongs to another
         account, or is a test-mode price against a live key (or the reverse).
       authentication_error → the key is not a secret key, or was rolled.
       See STRIPE_INTEGRATION_TODO.md for the full table."
  fi

  livemode="$(printf '%s' "$body" | sed -n 's/.*"livemode": *\(true\|false\).*/\1/p' | head -1)"
  recurring=no
  printf '%s' "$body" | grep -q '"recurring": *{' && recurring=yes
  active="$(printf '%s' "$body" | sed -n 's/.*"active": *\(true\|false\).*/\1/p' | head -1)"

  log "  price is readable with this key ✓   livemode=${livemode}  active=${active}  recurring=${recurring}"

  # Checkout is created with `mode: 'subscription'`, so a one-off price is
  # refused by Stripe with "not recurring" — a configuration fault that reaches
  # the customer as a withdrawn Upgrade button.
  [ "$recurring" = yes ] || die "That price is one-off, but checkout sells a subscription.
       Create a recurring monthly price on the Premium product and store its API ID."
  [ "$active" = true ]   || warn "That price is archived in Stripe. Checkout will refuse it."
  [ "$livemode" = true ] || warn "This is a TEST-mode price. Real cards will not be accepted."
fi

# ── Clean up ─────────────────────────────────────────────────────────────────
echo
if [ "${#TO_DESTROY[@]}" -eq 0 ]; then
  log "No junk versions to remove."
elif [ "$BLOCKED" = 1 ]; then
  warn "${#TO_DESTROY[@]} junk version(s) found, but not removing them while a secret's newest version is broken."
elif [ "$CLEAN" != 1 ]; then
  warn "${#TO_DESTROY[@]} junk version(s) found. Re-run with --clean to destroy them:"
  for item in ${TO_DESTROY[@]+"${TO_DESTROY[@]}"}; do warn "    ${item%%:*} version ${item##*:}"; done
else
  for item in ${TO_DESTROY[@]+"${TO_DESTROY[@]}"}; do
    name="${item%%:*}"; version="${item##*:}"
    log "Destroying ${name} version ${version} …"
    gcloud secrets versions destroy "$version" --secret="$name" --quiet \
      || warn "  Could not destroy version ${version} of ${name}."
  done
fi

# ── Make the service read what is stored ─────────────────────────────────────
#
# Cloud Run resolves `version = "latest"` when an instance starts, not when a
# version is added, so a new secret reaches nothing that is already running.
echo
if [ "$ROLL" = 1 ]; then
  [ "$BLOCKED" = 1 ] && die "Refusing to roll a revision while the configuration is broken."
  IMAGE="$(gcloud run services describe "$SERVICE" --region "$REGION" \
    --format='value(spec.template.spec.containers[0].image)')"
  [ -n "$IMAGE" ] || die "Could not read the current image for ${SERVICE}."
  log "Rolling a new revision on the same image …"
  gcloud run deploy "$SERVICE" --region "$REGION" --image "$IMAGE" --quiet >/dev/null
  log "Done. The new revision reads the latest version of every secret."
else
  warn "Nothing was rolled. A new secret version only reaches the service when a"
  warn "container starts — re-run with --roll, or deploy the API."
fi

echo
log "Verify from outside:"
log "  curl -s https://api.${ENV_NAME_DOMAIN:-parentix.ca}/api/auth/providers"
log "Then sign in and press Upgrade. A configuration fault withdraws the button;"
log "the reason is in the log: gcloud run services logs read ${SERVICE} --region ${REGION} --limit 50"

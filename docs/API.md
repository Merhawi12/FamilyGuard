# API reference

Base path `/api`. All request and response bodies are JSON.

## Authentication

Send the token as `Authorization: Bearer <token>`.

| Caller       | How it gets a token                                              |
| ------------ | ---------------------------------------------------------------- |
| Parent/staff | `POST /auth/login`, or `POST /auth/mfa/validate` when MFA is on   |
| Child device | `POST /devices/confirm` with the code shown in the Family App     |

Sessions are backed by a `Session` row, so an admin can revoke a live token.
A password reset revokes every session for that account.

**Roles.** `parent` is the default and is a customer. Staff roles are
departments: `super_admin`, `operations`, `support` (Customer Support),
`finance`, `marketing`.

Each role carries a default permission set, stored on the user's `permissions`
column and adjustable per account by a Super Admin — an exception does not need
a new role. Staff endpoints require a named permission on top of being staff.

| Role | Default permissions |
| ---- | ------------------- |
| Super Admin | all of them, implicitly — the only role that can manage staff accounts |
| Operations | `manage_users`, `manage_sessions`, `manage_settings`, `view_audit_logs`, `reset_passwords` |
| Customer Support | `manage_users`, `manage_sessions`, `reset_passwords` |
| Finance | `manage_billing` |
| Marketing | `send_notifications` |

`reset_passwords` is deliberately separate from `manage_users`: setting someone
else's password is a takeover of their account, so a Super Admin can grant the
ability to edit customer records without also granting the ability to seize one.

Finance and Marketing deliberately get no `manage_users`, so neither can open
the user directory or reach family data. `GET /admin/analytics` is aggregate
only and is open to every staff role.

Managing staff is reserved to `super_admin` rather than being a grantable
permission, so a department account can never award itself privileges. A Super
Admin cannot change their own role, deactivate themselves, or delete
themselves — which is what guarantees one always remains.

**Errors.** `{ "error": "message", "requestId": "…" }`. In production a 5xx
carries a generic message — the detail is in CloudWatch under that request id.

**Pagination.** Every list the console renders takes `limit` and `offset` and
answers `{ rows, count }`, where `count` is the unpaginated total. `limit`
defaults to 50 and is capped at 200 (500 for location history), so an oversized
value narrows rather than dumping the table. This covers `/admin/users`,
`/admin/devices`, `/admin/sessions/active`, `/admin/transactions`, `/notifications/sent`,
`/audit`, `/activity/:childId`, `/chats/:childId/messages` and
`/locations/:childId/history`.

**Rate limits.** 300 requests/minute per IP across `/api`, with tighter limits on
login (10 / 15 min), registration (5 / hour), code resend and password reset
(5 / 15 min), code submission (10 / 15 min), SMS code requests (3 / hour) and
upload signing (30 / 15 min). One-time codes carry a second set of limits counted
against the *account* rather than the IP — see "One-time codes" below.

---

## Auth — `/auth`

| Method | Path                  | Auth   | Notes                                                    |
| ------ | --------------------- | ------ | -------------------------------------------------------- |
| POST   | `/register`           | —      | `{name,email,password}`. Creates the account unactivated and mails a 6-digit code. No token yet. |
| POST   | `/verify-email`       | —      | `{email,code}` → `{token,user}`. Activates the account. A wrong code counts against both the code's own budget and the account lockout. |
| POST   | `/resend-code`        | —      | `{email}`. 429 with `retryAfter` (seconds) inside the per-account cooldown or over the hourly quota. |
| POST   | `/login`              | —      | `{email,password}` → `{token,user}`, or `{mfaRequired,preAuthToken}` |
| GET    | `/providers`          | —      | → `{password,google,phone}`. Which identifiers this deployment can prove. |
| POST   | `/google`             | —      | `{credential}` (a Google ID token) → `{token,user,created}` |
| POST   | `/phone/request`      | —      | `{phone,mode,name?}` → `{phone,message,smsDelivered}`. Sends a 6-digit code; 429 with `retryAfter` when limited. |
| POST   | `/phone/verify`       | —      | `{phone,code}` → `{token,user}`, or `{mfaRequired,preAuthToken}` |
| POST   | `/forgot-password`    | —      | `{email}`. Mails a 6-digit code. Always 200 with the same body, whether or not the account exists and whether or not a code was actually sent. |
| POST   | `/verify-reset-code`  | —      | `{email,code}` → `{resetToken,expiresIn}`. Single use, 15 minutes. Every refusal is the same 400. |
| POST   | `/reset-password`     | —      | `{token,newPassword}` — the `resetToken` from the step above. Revokes all sessions. |
| GET    | `/me`                 | user   | The current user                                          |
| POST   | `/logout`             | user   | Revokes the calling session                               |
| PUT    | `/profile`            | user   | `{name,email}`                                            |
| PUT    | `/password`           | user   | `{currentPassword,newPassword}`. `currentPassword` is not required when the account has none yet — see below |
| GET    | `/notification-prefs` | user   |                                                           |
| PUT    | `/notification-prefs` | user   |                                                           |
| GET    | `/sessions`           | user   | Own live sessions, newest first. Each carries `current`    |
| DELETE | `/sessions/:id`       | user   | Ends one other session. 400 on the calling one — that is `/logout` |
| DELETE | `/sessions/others`    | user   | Ends every session but this one → `{revoked}`              |
| DELETE | `/account`            | user   | `{password}`, or `{confirm:'DELETE'}` for an account with none. Cancels the subscription, then erases the account and every child on it |

Passwords must be at least 10 characters (`MIN_PASSWORD_LENGTH`) and contain a
letter and a digit. Five failed logins lock the account for 15 minutes.

### One-time codes

Signup verification, phone sign-in and password reset all run on the same
engine (`utils/otp.js`), so the rules below hold for every 6-digit code the
service issues:

- **Stored as a keyed HMAC, never as digits.** The key is derived from
  `JWT_SECRET`, which is not in the database — so a dump yields nothing usable,
  and the hash cannot be presented in place of the code. Codes are readable only
  from the message, or from the log when `EMAIL_PROVIDER=none`.
- **15 minutes**, then the code is dead.
- **Five wrong guesses** destroy the code itself, on top of the per-IP limiter.
  Ask for a new one; a new code gets a fresh budget.
- **One code a minute, five an hour, per account** — counted against the
  recipient rather than the caller, because the per-IP limiters do nothing about
  requests spread across machines at one stranger's inbox. `resend-code` and
  `phone/request` say so with 429 and `retryAfter`; `forgot-password` refuses
  silently, because a 429 there would confirm the address has an account.
- **A completed verification clears the send budget**, so signing out and back
  in within the minute is not refused.
- Every issue, failure, throttle and success is written to the audit log.

Verification and phone codes additionally count a failure towards the account
lockout. The reset code deliberately does **not** — locking the recovery path
from an unauthenticated endpoint would let anyone who knows an address shut its
owner out of the only way back in.

A deactivated account (a blocked customer, or staff switched off by a Super
Admin) is refused at login with 403 rather than being handed a token that every
later request would reject.

`GET /me` includes `permissions` for a staff account, which the Admin Dashboard
uses to hide screens the role cannot use. It is a convenience only — every
endpoint checks server-side. It also carries `hasPassword`, which is how a
client knows whether to ask for the current one.

An account created through Google or a phone number has no password at all, so
`PUT /password` accepts a first one without `currentPassword`. Without that the
endpoint was unreachable for those accounts: the form was shown and every
submission answered "Current password is incorrect".

`DELETE /account` is the only irreversible endpoint on the service. It cancels
any Stripe subscription **first** and deletes nothing if that fails — an account
that still exists can be closed again, one that was deleted while its
subscription renews goes on charging a card its owner can no longer reach. The
same erasure runs behind the console's `DELETE /admin/clients/:id`, so both doors
remove the children, devices, locations, messages, contacts, alerts and activity
rather than only the `users` row.

### Phone sign-in

Passwordless. `mode: 'register'` creates the account and `mode: 'login'` signs an
existing one in; both send a code, and `/phone/verify` ends exactly where
`/login` does — a session, or an MFA challenge if the account has one. An account
created this way has no email and no password, which is why both columns are
nullable (migration 0012).

Numbers are stored in E.164 and looked up only through `User.findByPhone`, so
`+1 415 555 0123` and `(415) 555-0123` are one account rather than two. A number
without a country code is refused rather than guessed at. The response masks the
number it was given (`+•••••••0123`) — it was supplied to receive one message,
not to be echoed into logs and error trackers.

`smsDelivered` reports whether the code actually left the building, and the
sign-in page says so rather than showing a "check your phone" screen for a
message that was never sent.

**Whether the flow is offered at all** comes from `GET /auth/providers`, and is
not the same question as whether an SMS can be sent:

| Environment | SMS credentials | `providers.phone` | Where the code goes |
| ----------- | --------------- | ----------------- | ------------------- |
| production  | configured      | `true`            | the handset          |
| production  | missing         | `false` — tab hidden | nowhere; the flow is not offered |
| development | any             | `true`            | the API log, and `devCode` in the response |

`devCode` exists because development has no credentials and never will, so
gating the tab on deliverability alone made the feature unreachable on the only
machine anyone develops on. It is off in production by construction, and a
production boot with `SMS_ECHO_CODE` set is refused outright rather than
silently ignoring it. See `SMS_ECHO_CODE` in `services/api/.env.example`.

### MFA — `/auth/mfa`

| Method | Path        | Auth | Notes                                                     |
| ------ | ----------- | ---- | --------------------------------------------------------- |
| POST   | `/setup`    | user | → `{secret,qrCode,otpauth}`                                |
| POST   | `/enable`   | user | `{code}` → `{backupCodes}` (8, shown once)                 |
| POST   | `/disable`  | user | `{password,code}`                                          |
| POST   | `/validate` | —    | `{preAuthToken,code}` → `{token,user}`. Accepts a backup code, which is then burnt. |

---

## Family data

All of these are scoped to the calling parent; another parent's records return
404, never someone else's data.

### Children — `/children`

| Method | Path   | Body                                    |
| ------ | ------ | --------------------------------------- |
| GET    | `/`    | Active children, with devices and rules |
| POST   | `/`    | `{name,age?,avatar?}`                   |
| PUT    | `/:id` | `{name?,age?,avatar?,avatarUrl?}`       |
| DELETE | `/:id` | Soft delete                             |

`avatarUrl` must be a URL issued by `/uploads/child-avatar` to the calling
parent; anything else is rejected with 400. Replacing or clearing it deletes the
previous object.

### Devices — `/devices`

| Method | Path              | Auth   | Notes                                          |
| ------ | ----------------- | ------ | ---------------------------------------------- |
| GET    | `/`               | parent | Linked devices                                 |
| POST   | `/link`           | parent | `{childId,deviceName,type}` → `{device,code}`, 30 min TTL. The child must be active |
| PATCH  | `/:id`            | parent | Rename a device or correct its type            |
| POST   | `/:id/link`       | parent | A fresh code for a device that never connected; refuses one already linked |
| DELETE | `/:id`            | parent | Revokes the device                             |
| POST   | `/confirm`        | —      | `{code,type?,osVersion?,deviceId?}` → `{device,deviceToken}` |
| GET    | `/me/rules`       | device | All rules for this device's child, plus the child's name |
| GET    | `/me/contacts`    | device | The approved contact list                      |
| POST   | `/me/heartbeat`   | device |                                                |
| POST   | `/me/activity`    | device | App-usage upsert (one row per app per day)     |
| POST   | `/me/web-history` | device | A batch of resolved domains, ≤200 per request  |

`type` on `/confirm` is the device correcting its own row as it links. The parent
picks a type on a dashboard that is, by definition, not the computer or phone
being set up, so a household with more than one kind of device can easily hand
the wrong code to the wrong machine — and the row would carry the wrong icon and
label for ever, because nothing revisits it. It is validated against the same
list the parent chose from (`android`, `ios`, `windows`, `mac`), and an
unrecognised value is **ignored rather than refused**: this field only decides an
icon, and a client sending something a deployment has not heard of must not be
unable to link because of it.

**Linking.** A code is eight uppercase hex characters, matched case-insensitively,
single-use, and cleared from the row the moment it is spent — a second
presentation is a 404, not a "already linked". `deviceId` may be sent alongside
it (the QR payload carries both) and is cross-checked when present. The claim
itself is a conditional `UPDATE`, so two requests racing the same code produce
one token and one 400.

`/confirm` refuses any link the account could not honour, because each one used
to answer 200 with a token that then failed on every call the phone made:

| Status | Meaning |
| ------ | ------- |
| 404 | no such code — unknown, already spent, or superseded |
| 400 | expired, already linked, or lost the race |
| 410 | the device was removed, or its child was |
| 403 | the parent's account is not active |

On success the parent's realtime room receives `device:linked`
(`{deviceId, childId, name, type, osVersion, linkedAt}`), which is how the
Family App's link sheet knows the phone arrived.

**Unlinking.** A parent removes a device with `DELETE /devices/:id` — the bin
icon on the device card in Children — and removing a *child* revokes every
device attached to them. Both take the same three steps, and all three matter:

1. **The row is deactivated** (`isActive: false`, a soft delete that keeps the
   child's reporting history) and its `pushToken` column is cleared. The device
   token authenticates against `isActive` alone, so from this moment every REST
   call answers `401 device_unlinked`, the device drops out of the parent's list,
   and the plan's device allowance frees the slot.
2. **Live sockets are cut**, after being told why. The handshake check only runs
   on connect, so an already-open socket would otherwise keep streaming; the
   `device:unlinked` event goes out immediately before the disconnect, which is
   what lets the agent clear its credentials and return to the linking screen
   rather than sit on a "Linked" badge retrying forever.
3. **The push token is destroyed.** It is a bearer credential for that handset,
   and a removal that leaves one behind is not a removal.

All three live in `revokeDeviceAccess` (`utils/session.js`) rather than at the
call sites, because they were at the call sites and two of the three callers
were a step short. Account erasure is the exception and does its own bulk delete
inside its transaction.

Re-linking the same handset later is an ordinary new link: it registers its push
token again on first run.

**Revocation says which kind it is.** A refused device token — over REST as
`401 {error, code}`, over Socket.IO as a handshake error carrying `data.code` —
is one of:

| `code` | Meaning | What the child app does |
| ------ | ------- | ----------------------- |
| `device_unlinked` | the device row is gone; permanent | discards its credentials and caches, and returns to the linking screen |
| `account_suspended` | the parent is blocked or the child deactivated; temporary | keeps its token and retries |

Removing a device also emits `device:unlinked` to `device:<id>` immediately
before its sockets are cut, so a phone that is online learns why rather than
seeing an ordinary disconnect.

**Pausing one device.** `POST /devices/:id/block` and `POST /devices/:id/unblock`
pause and resume a single device, leaving its siblings alone. Both are
idempotent, and both are a different thing from removal:

|  | Block | Remove |
| --- | ----- | ------ |
| Token | still valid | dead for ever |
| Syncing, heartbeat, location | **continue** | stop |
| Socket | stays open | cut |
| Screen | locked | untouched |
| Reversible | one tap | no — needs a new linking code |

The device stays authenticated on purpose. Revoking the token instead would send
the phone dark *while it carried on enforcing its last-known rules*, so the
parent would read "paused" on a device they had actually just lost sight of — and
the unblock would have no way to reach it.

A blocked device learns of it two ways: `device_blocked` / `device_unblocked` on
its own `device:<id>` room, which applies the lock within about a second, and a
`blocked` field on every `GET /devices/me/rules` — `{since, reason}` or `null` —
which is what covers a device that was switched off or offline when the event
went out. `reason` is `blocked_by_parent`, a lock reason alongside `daily_limit`,
`bedtime` and `outside_schedule`; a client that has never heard of it still
locks, because both agents treat an unrecognised reason as "locked, no specific
explanation".

Removing a device clears `blockedAt`, so a replacement linked in its place does
not inherit a pause.

### Per-device rules

Every rule row carries a nullable `deviceId`. `null` means the rule applies to
**every device the child owns**, which is what all rules meant before per-device
control existed and is still what the dashboard writes unless the parent narrows
it. A row naming a device applies to that device **instead of** the child-wide
row it collides with.

Override, not union. A union cannot express "the school laptop gets three hours,
everything else gets one" — the child-wide hour would still bite and the laptop
would lock at the same moment. What counts as a collision is decided once, in
`utils/deviceScope.js`: app rules by package name, website rules by domain (or by
category when they carry no domain), and screen time as a whole rule.

The resolution happens server-side inside the sync the device already makes, so
a phone is handed only the rules that apply to it and never learns that a rule
for its sibling exists.

Removing a device deletes the rules that named it. The child-wide rows are
untouched — they belong to the child, and the siblings still obey them.

### Screen time — `/screen-time`

`GET|PUT|DELETE /:childId`, each taking an optional `?deviceId=`.

Without it they read and write the child's rule, exactly as before. With it:

- `GET` returns that device's own rule if it has one, otherwise the child's —
  **it never creates an exception**. Tell them apart by `deviceId` on the
  response: the device's id for an exception, `null` for the shared rule. This
  matters because the Screen Time page reads every device at once to mark which
  tabs carry an override; if reading created rows, opening the page would
  override every device and the child-wide limit would stop reaching any of them.
- `PUT` creates the exception on first save, **as a copy of the child's rule**
  rather than from the model defaults — otherwise narrowing a rule would silently
  hand that device the default 120-minute limit and a bedtime nobody chose.
- `DELETE` drops the exception so the device follows the child's rule again.
  Distinct from typing the child's numbers back in, which leaves an exception
  that merely agrees today and stops tracking the child rule the moment it
  changes.

`screen_time_updated` is emitted to `device:<id>` for a device rule and to
`child:<id>` for a child-wide one.

### Deleting recorded data

Three screens can now destroy what they show. All of them are audited — a
monitoring record that can be removed without trace is a different product from
one that cannot, and the audit entry is what tells anyone else on the account
that a row was *deleted* rather than never recorded.

| Route | Removes |
| ----- | ------- |
| `DELETE /alerts/:id` | one alert |
| `DELETE /alerts` | alerts matching `?unreadOnly=` / `?severity=` — all of them with neither |
| `DELETE /activity/:childId/entries/:entryId` | one activity or browsing record |
| `DELETE /activity/:childId/web-history` | browsing records, honouring `?from`/`?to` |
| `DELETE /activity/:childId` | every category, honouring `?from`/`?to` |

Each returns `{ deleted: n }`. The count comes from the database rather than
from the caller's list, which holds one page and may be far short of the total.

**Bulk deletes honour the screen's filters, deliberately.** A parent looking at
"High", or at one week, is asking about what is in front of them; a clear that
silently widened to everything would destroy rows they cannot see, which is the
one outcome a confirmation dialog is unable to warn about. `DELETE /alerts`
refuses an unrecognised `severity` with a 400 rather than dropping the key and
widening to everything.

**Web History and the Activity Log are the same table**, so deletes cross
between them: a browsing row is an `ActivityLog` row with `category: 'browsing'`,
and the Activity Log shows every category. Deleting one row removes it from both
screens; clearing the Activity Log clears the web history too. The Family App's
confirmation copy states this, because a parent who discovered it afterwards
could not tell a deletion from a device that had stopped reporting.

`?search` is **not** honoured by `DELETE …/web-history`. Search decrypts and
filters over a capped scan, so a search-scoped delete could only remove the rows
that scan happened to reach while reporting success. The Family App hides the
clear button while a search is active rather than offering a partial delete.

### Blocking — `/blocking`

`GET|POST /:childId/apps`, `DELETE /:childId/apps/:ruleId`, and the same three
for `/websites`. Both `POST`s accept an optional `deviceId` in the body to
narrow the rule to one device; an id that is not a live device of *that child* is
a 400. `rules_updated` goes to `device:<id>` for a device rule and to
`child:<id>` for a child-wide one.

`GET /:childId/apps/known` lists the apps this child's devices have reported
using — `{appName, appPackage, totalMinutes}`, most-used first — so the rule form
can offer a real package name instead of asking a parent to know one.

**An app rule must carry an `appPackage`.** The accessibility service on the
phone matches on the package and nothing else, so a rule without one is not a
weaker rule, it is no rule: it appeared in the parent's "Active app rules" with a
Block badge and changed nothing on the device. It is now a 400.

`action` is `block` or `limit`. A `limit` rule needs `dailyLimitMinutes`
(5–1440); the device blocks that app once its own usage for the day reaches it,
and releases it when usage resets at midnight. `allow` is deliberately not an app
action — for apps it means blocking every other app on the phone, including the
dialer, and the device has no way to express the exception.

A website rule's `url` is normalised to a bare hostname on create — scheme,
path, port, credentials and a leading `www.` are stripped — because the device
enforces these by matching DNS queries. Anything that could never match one
(`this is not a website`, `localhost`) is rejected with 400 rather than stored
as a rule that silently blocks nothing. A category-only rule needs no `url`, but
a rule with neither a `url` nor a real category is rejected. Its `action` is
`block` or `allow`, and `allow` is real here: `utils/contentPolicy` folds it into
the domain lists the device is handed, where it overrides a block.

### Activity — `/activity`

`GET /:childId` (`from`, `to`, `limit`, `offset`), `POST /`

### Reports — `/reports`

`GET /:childId/daily?date=YYYY-MM-DD`, `GET /:childId/weekly`

### Location — `/locations`

| Method | Path                | Auth   |
| ------ | ------------------- | ------ |
| POST   | `/`                 | device |
| POST   | `/:childId/manual`  | parent |
| GET    | `/:childId/current` | parent |
| GET    | `/:childId/history` | parent |

`POST /` is the device reporting itself. The device token identifies the child
and device — neither may be supplied in the body.

`POST /:childId/manual` is the parent setting a position from the dashboard
(`{ latitude, longitude, accuracy?, address? }`). A parent holds no device
token, so this authorises on ownership of the child instead. The fix is
attributed to the child's first linked device — with no device linked it
returns 400 — and it deliberately does not refresh that device's `lastSeen`,
since a position the parent typed says nothing about whether the phone is
alive. Requires the `gps_tracking` entitlement.

### Safe zones — `/safe-zones`

`GET /`, `POST /`, `PUT /:id`, `DELETE /:id`

### Contacts — `/contacts`

`GET /`, `POST /`, `PUT /:id`, `DELETE /:id`

### Chat — `/chats`

| Method | Path                            | Auth   | Notes                                              |
| ------ | ------------------------------- | ------ | -------------------------------------------------- |
| GET    | `/:childId/messages`            | parent | Paginated. Marks the child's messages read          |
| POST   | `/:childId/messages`            | parent | `{text, messageType?}`                              |
| GET    | `/me/messages`                  | device | The child reads its own thread; child from the token. Paginated, marks the parent's messages read |
| POST   | `/:childId/messages/from-child` | device | `{text, messageType?}`                              |

`from-child` derives the child from the device token, not the URL. A message of
type `emergency` raises an `emergency_button` alert; message text is screened
for cyberbullying indicators.

### Alerts — `/alerts`

`GET /?unreadOnly=`, `PUT /:id/read`, `PUT /read-all`

### Notifications — `/notifications`

`GET /`, `PATCH /:id/read`, `PATCH /read-all`, plus staff-only `POST /` and
`GET /sent` (permission `send_notifications`).

### Uploads — `/uploads`

`POST /child-avatar` — `{childId, contentType, contentLength?}` →
`{uploadUrl, key, url, expiresIn}`.

`contentType` must be `image/jpeg`, `image/png` or `image/webp`; the maximum is
`MAX_UPLOAD_BYTES` (5 MB). `PUT` the bytes to `uploadUrl` with a matching
`Content-Type` and no `Authorization` header, then save `url` on the child.
Returns 503 when object storage is not configured.

### Safety — `/safety`

`POST /analyze` — runs pattern analysis for the calling parent immediately
(it also runs hourly in the background).

---

## Payments — `/payments`

| Method | Path                       | Auth   |
| ------ | -------------------------- | ------ |
| POST   | `/create-checkout-session` | parent |
| POST   | `/customer-portal`         | parent |
| GET    | `/subscription`            | parent |
| POST   | `/webhook`                 | Stripe signature |

The webhook handles `checkout.session.completed` and
`customer.subscription.deleted`, and is idempotent per event id. Without a
Stripe key these routes degrade to 503 while the rest of the API stays up.

---

## Staff — `/admin`, `/audit`

Requires a staff role; most endpoints require a named permission on top.

The `/clients`, `/users/:id` and `/users/:id/approve` routes act on customers
only — a staff account is never returned or modified through them, so
`manage_users` cannot reach a colleague's account. Staff are managed at
`/admin/staff`.

### Staff accounts — Super Admin only

| Method | Path                        | Notes                                                    |
| ------ | --------------------------- | -------------------------------------------------------- |
| GET    | `/staff`                    | Staff plus the role catalogue and their default permissions |
| POST   | `/staff`                    | `{name,email,role,permissions?,password?}`. Without a password one is generated and returned **once** as `generatedPassword` |
| PUT    | `/staff/:id`                | `{name?,email?,role?,permissions?}`. A role change re-seeds the defaults unless `permissions` is given; either revokes that account's sessions |
| PATCH  | `/staff/:id/status`         | `{isActive}`. Deactivating revokes sessions and blocks sign-in |
| POST   | `/staff/:id/reset-password` | `{password?}` — otherwise generated. Revokes sessions and clears any lockout |
| DELETE | `/staff/:id`                | Permanent                                                 |

Refuses acting on your own account for role changes, deactivation and deletion.

### Customers

| Method | Path                       | Notes                                    |
| ------ | -------------------------- | ---------------------------------------- |
| GET    | `/clients`                 |                                          |
| PATCH  | `/clients/:id/toggle-block`| Blocking revokes the user's sessions      |
| PATCH  | `/clients/:id/plan`        |                                          |
| DELETE | `/clients/:id`             | Erases the account and every child on it — devices, locations, messages, contacts, alerts, activity. Does **not** cancel their subscription: that is a billing decision, and `hadSubscription` is recorded on the audit row |
| GET    | `/users`                   | `search`, `role`, `plan`, `status`, `limit`, `offset` → `{rows,count,summary}`. Each row carries `childCount` and `deviceCount` (active only). `summary` describes the whole customer directory — totals, blocked, Premium share, and 30 days of signups zero-filled by day — and ignores the filters, because the tiles on the screen report the platform, not the page |
| POST   | `/users`                   | Creates a parent; staff must go through `/admin/staff` |
| PUT    | `/users/:id`               |                                          |
| PATCH  | `/users/:id/role`          | Super Admin only — moves an account across the staff boundary. Revokes sessions |
| PATCH  | `/users/:id/approve`       |                                          |
| POST   | `/users/:id/reset-password` | Permission `reset_passwords`. `{password?}` — omit to generate one, returned once as `generatedPassword`. Revokes sessions, clears any lockout, audited as `admin.user_password_reset` |
| GET    | `/devices`                 | Permission `manage_users`. The whole fleet: `search` (device, child, account name or email), `platform`, `status` (`online`/`offline`/`pending`), `limit`, `offset` → `{rows,count,summary}`. Read-only; a row carries its child, its owner, its derived status and that child's rule counts, never its push token |
| GET    | `/sessions/active`         | Paginated → `{rows,count}`                |
| GET    | `/users/:id/sessions`      |                                          |
| DELETE | `/sessions/:sessionId`     | Force logout of one session               |
| DELETE | `/users/:id/sessions`      | Force logout everywhere                   |
| GET    | `/transactions`            | Permission `manage_billing`               |
| GET    | `/users/:id/transactions`  | Permission `manage_billing`               |
| GET    | `/settings`                |                                          |
| PUT    | `/settings`                |                                          |
| GET    | `/analytics`               | Signups, plan mix, revenue, MFA adoption  |
| GET    | `/audit`                   | Audit log, filterable                     |

---

## Public

| Method | Path           | Notes                                    |
| ------ | -------------- | ---------------------------------------- |
| POST   | `/contact`     | Marketing-site contact form              |
| GET    | `/health`      | Liveness — the ALB target check          |
| GET    | `/ready`       | Liveness plus a database check           |

---

## Realtime (Socket.IO)

Connect to the API origin with the JWT in the handshake:

```js
io(SOCKET_URL, { auth: { token } });
```

A parent token joins `parent:<id>`; a device token joins `child:<id>` and
`device:<id>`. Membership comes from the token alone — ids sent by the client are
ignored, and a pre-auth (MFA-incomplete) token is refused.

**Device → server:** `device:heartbeat`, `activity:update`, `location:update`,
`chat:send`, and the alert events `alert:blocked_app`,
`alert:screen_time_exceeded`, `alert:app_installed`, `alert:dangerous_content`,
`alert:unknown_contact`.

**Parent → server:** `chat:reply` (the target child is verified against the
authenticated parent).

**Server → client:** `alert:new`, `chat:message`, `chat:delivered`,
`activity:update`, `location:update`, `device:online`.

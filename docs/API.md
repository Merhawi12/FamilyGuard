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
`/admin/sessions/active`, `/admin/transactions`, `/notifications/sent`,
`/audit`, `/activity/:childId`, `/chats/:childId/messages` and
`/locations/:childId/history`.

**Rate limits.** 300 requests/minute per IP across `/api`, with tighter limits on
login (10 / 15 min), registration (5 / hour), code resend and password reset
(5 / 15 min), and upload signing (30 / 15 min).

---

## Auth — `/auth`

| Method | Path                  | Auth   | Notes                                                    |
| ------ | --------------------- | ------ | -------------------------------------------------------- |
| POST   | `/register`           | —      | `{name,email,password}`. Sends a 6-digit code. No token yet. |
| POST   | `/verify-email`       | —      | `{email,code}` → `{token,user}`                           |
| POST   | `/resend-code`        | —      | `{email}`                                                 |
| POST   | `/login`              | —      | `{email,password}` → `{token,user}`, or `{mfaRequired,preAuthToken}` |
| POST   | `/forgot-password`    | —      | `{email}`. Always 200, whether or not the account exists. |
| POST   | `/reset-password`     | —      | `{token,newPassword}`. Revokes all sessions.              |
| GET    | `/me`                 | user   | The current user                                          |
| POST   | `/logout`             | user   | Revokes the calling session                               |
| PUT    | `/profile`            | user   | `{name,email}`                                            |
| PUT    | `/password`           | user   | `{currentPassword,newPassword}`                           |
| GET    | `/notification-prefs` | user   |                                                           |
| PUT    | `/notification-prefs` | user   |                                                           |

Passwords must be at least 10 characters (`MIN_PASSWORD_LENGTH`) and contain a
letter and a digit. Five failed logins lock the account for 15 minutes.

A deactivated account (a blocked customer, or staff switched off by a Super
Admin) is refused at login with 403 rather than being handed a token that every
later request would reject.

`GET /me` includes `permissions` for a staff account, which the Admin Dashboard
uses to hide screens the role cannot use. It is a convenience only — every
endpoint checks server-side.

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

| Method | Path            | Auth   | Notes                                            |
| ------ | --------------- | ------ | ------------------------------------------------ |
| GET    | `/`             | parent | Linked devices                                   |
| POST   | `/link`         | parent | `{childId,deviceName,type}` → `{code,qrCode}`, 30 min TTL |
| DELETE | `/:id`          | parent | Revokes the device                               |
| POST   | `/confirm`      | —      | `{code}` → `{device,deviceToken}`                |
| GET    | `/me/rules`     | device | All rules for this device's child                |
| POST   | `/me/heartbeat` | device |                                                  |
| POST   | `/me/activity`  | device | App-usage upsert (one row per app per day)       |

### Screen time — `/screen-time`

`GET|PUT /:childId`

### Blocking — `/blocking`

`GET|POST /:childId/apps`, `DELETE /:childId/apps/:ruleId`, and the same three
for `/websites`.

A website rule's `url` is normalised to a bare hostname on create — scheme,
path, port, credentials and a leading `www.` are stripped — because the device
enforces these by matching DNS queries. Anything that could never match one
(`this is not a website`, `localhost`) is rejected with 400 rather than stored
as a rule that silently blocks nothing. A category-only rule needs no `url`.

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
| DELETE | `/clients/:id`             |                                          |
| GET    | `/users`                   | `role`, `plan`, `status`, `limit`, `offset` |
| POST   | `/users`                   | Creates a parent; staff must go through `/admin/staff` |
| PUT    | `/users/:id`               |                                          |
| PATCH  | `/users/:id/role`          | Super Admin only — moves an account across the staff boundary. Revokes sessions |
| PATCH  | `/users/:id/approve`       |                                          |
| POST   | `/users/:id/reset-password` | Permission `reset_passwords`. `{password?}` — omit to generate one, returned once as `generatedPassword`. Revokes sessions, clears any lockout, audited as `admin.user_password_reset` |
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

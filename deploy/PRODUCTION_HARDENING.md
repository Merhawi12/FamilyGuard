# Parentix — Production Hardening Runbook

Prepared steps for the remaining infra/security items from the audit. Each section
is **not yet executed** — it needs your server / Google Play access. Do them in order.

---

## 1. TLS / HTTPS at nginx

Today the API and mobile traffic (child GPS + a 1-year device token) travel over
plain HTTP. This terminates TLS at nginx for `parentix.ca`.

### 1.1 DNS
Point A records at the server's public IP (currently `18.226.58.189`):
```
parentix.ca.      A   18.226.58.189
www.parentix.ca.  A   18.226.58.189
```
Verify: `dig +short parentix.ca` returns the IP before continuing.
> If the IP is not an AWS Elastic IP, allocate/associate one so it can't change.

### 1.2 Issue the certificate
```bash
sudo apt-get update && sudo apt-get install -y certbot python3-certbot-nginx
sudo mkdir -p /var/www/certbot
# Webroot issuance (keeps our committed nginx.conf authoritative):
sudo certbot certonly --webroot -w /var/www/certbot \
  -d parentix.ca -d www.parentix.ca --agree-tos -m meradeki@gmail.com --no-eff-email
```

### 1.3 Deploy the nginx config
```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/parentix
sudo ln -sf /etc/nginx/sites-available/parentix /etc/nginx/sites-enabled/parentix
sudo nginx -t && sudo systemctl reload nginx
```
`deploy/nginx.conf` already: redirects :80 → :443, serves the ACME challenge,
enables TLS1.2/1.3 + HSTS, and proxies `/api/` and `/socket.io/` to `:5000`.

### 1.4 Backend + client env
- Backend `.env`: set `CLIENT_URL=https://parentix.ca` (CORS + socket origin) and
  `NODE_ENV=production` (the error handler now hides internals only in production).
  Restart: `pm2 restart parentix-api` (or the current PM2 name).
- The app already sets `trust proxy` so `req.ip` / rate limits see the real client.
- Client build is origin-relative (`VITE_API_URL` empty) — no change needed.

### 1.5 Auto-renewal
Certbot installs a renew timer. Confirm and add an nginx reload hook:
```bash
sudo certbot renew --dry-run
echo -e '#!/bin/sh\nsystemctl reload nginx' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
```

### 1.6 Verify
```bash
curl -I http://parentix.ca            # → 301 to https
curl -s https://parentix.ca/api/health   # → {"status":"ok",...}
```

---

## 2. Android release keystore (stop shipping the debug key)

Release builds were signed with the committed `debug.keystore` (public password
`android`). `app/build.gradle` now signs release with a real keystore loaded from a
git-ignored `keystore.properties`, falling back to debug **with a warning** if absent.
`debug.keystore` stays tracked — it's the universal RN debug key and is only used for
debug builds now.

### 2.1 Generate the upload key (run once, locally)
```bash
cd mobile/android
./generate-release-keystore.sh
```
This creates `parentix-release.keystore` + `keystore.properties` (both git-ignored).
**Back both up in your password manager / secrets vault.** Losing the keystore means
you cannot publish updates to the same Play listing without a key reset.

### 2.2 Build a signed bundle
```bash
cd mobile/android
./gradlew bundleRelease
# → app/build/outputs/bundle/release/app-release.aab  (upload to Play Console)
```
Sanity-check it is NOT debug-signed:
```bash
keytool -list -printcert -jarfile app/build/outputs/bundle/release/app-release.aab | grep -i "CN="
# should show CN=Parentix, not CN=Android Debug
```
> Recommended: also enroll in **Google Play App Signing** so Google holds the app
> signing key and your generated key is just the upload key.

---

## 3. Rotate the exposed SMTP credential

The working-tree `server/.env` contains a real Gmail App Password (it is git-ignored
and was never committed, but it has been exposed in this working copy).

1. Google Account → Security → App passwords → **revoke** the current Parentix password.
2. Create a new App password, update `SMTP_PASS` in the server `.env`, `pm2 restart`.
3. Send a test (e.g. trigger a password-reset email) and confirm delivery.

> **Do NOT rotate `FIELD_ENCRYPTION_KEY`** — it decrypts existing stored data
> (e.g. activity-log URLs). Changing it without re-encrypting corrupts that data.
> Rotating `JWT_SECRET` is safe but logs everyone out (all tokens/sessions invalidated).

---

## 4. Mobile → HTTPS

Defaults in `mobile/src/services/api.js` and `rules.js` now point at
`https://parentix.ca` (were the raw HTTP IP). Override per-build if needed:
```
EXPO_PUBLIC_API_URL=https://parentix.ca/api
EXPO_PUBLIC_SOCKET_URL=https://parentix.ca
```
Rebuild the app (§2.2) after TLS is live so the child device talks HTTPS end-to-end.

---

## 5. Post-rollout checklist
- [ ] `https://parentix.ca` loads; `http://` redirects to `https://`
- [ ] `GET https://parentix.ca/api/health` returns ok
- [ ] Login + a real-time event (alert/location) work over `wss://`
- [ ] `certbot renew --dry-run` passes
- [ ] Release `.aab` shows `CN=Parentix` (not Android Debug)
- [ ] Old SMTP app password revoked; new one delivers mail
- [ ] `NODE_ENV=production` and `CLIENT_URL=https://parentix.ca` set on the server

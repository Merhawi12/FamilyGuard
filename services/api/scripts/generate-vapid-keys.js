#!/usr/bin/env node
/**
 * Generate the VAPID keypair that Web Push to a parent's browser needs.
 *
 * Run once per deployment and keep the result: the public key is what browsers
 * subscribe against, so replacing it invalidates every existing subscription and
 * every parent has to turn notifications on again.
 *
 *   node scripts/generate-vapid-keys.js
 */
const webpush = require('web-push');

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log(`
Add these to the API's environment (Secret Manager in production):

VAPID_PUBLIC_KEY=${publicKey}
VAPID_PRIVATE_KEY=${privateKey}
VAPID_SUBJECT=mailto:support@parentix.ca

The private key is a credential — anyone holding it can send notifications to
every subscribed browser. Keep it out of the repository and out of the client
bundle; only VAPID_PUBLIC_KEY is ever served to a browser.
`);

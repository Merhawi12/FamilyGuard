const crypto = require('crypto');
const { env } = require('../config/env');

const generateLinkingCode = () => crypto.randomBytes(4).toString('hex').toUpperCase();

const generateInviteToken = () => crypto.randomBytes(20).toString('hex');

// AES-256-GCM field-level encryption.
// Requires FIELD_ENCRYPTION_KEY env var: 64 hex chars (32 bytes).
const ALGORITHM = 'aes-256-gcm';

const getKey = () => {
  const hex = env.auth.fieldEncryptionKey;
  if (!hex || hex.length !== 64) throw new Error('FIELD_ENCRYPTION_KEY must be 64 hex chars');
  return Buffer.from(hex, 'hex');
};

const encrypt = (plaintext) => {
  if (plaintext == null) return null;
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv(12):tag(16):ciphertext — all base64, joined with ':'
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
};

const decrypt = (value) => {
  if (value == null) return null;
  // Return plain values that were stored before encryption was enabled
  if (!value.includes(':')) return value;
  const key = getKey();
  const [ivB64, tagB64, dataB64] = value.split(':');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data, undefined, 'utf8') + decipher.final('utf8');
};

/**
 * A deterministic index for a value that is stored encrypted.
 *
 * `encrypt` uses a fresh IV each time, so the same domain never produces the
 * same ciphertext twice — which is what makes the stored history unreadable
 * without the key, and also what makes `WHERE url = ?` impossible. This gives
 * one stable, non-reversible token per value so equality lookups still work:
 * folding repeat visits onto one row, and filtering a history to one site.
 *
 * The HMAC key is derived from the field-encryption key with a domain-separation
 * label rather than being the key itself, so a leaked index cannot be replayed
 * against anything else that key protects. Values are lower-cased first so a
 * lookup does not depend on how the domain happened to be capitalised.
 */
const blindIndex = (value) => {
  if (value == null) return null;
  const key = crypto.createHmac('sha256', getKey()).update('blind-index-v1').digest();
  return crypto.createHmac('sha256', key).update(String(value).trim().toLowerCase()).digest('hex');
};

module.exports = { generateLinkingCode, generateInviteToken, encrypt, decrypt, blindIndex };

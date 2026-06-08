const crypto = require('crypto');

const generateLinkingCode = () => crypto.randomBytes(4).toString('hex').toUpperCase();

const generateInviteToken = () => crypto.randomBytes(20).toString('hex');

// AES-256-GCM field-level encryption.
// Requires FIELD_ENCRYPTION_KEY env var: 64 hex chars (32 bytes).
const ALGORITHM = 'aes-256-gcm';

const getKey = () => {
  const hex = process.env.FIELD_ENCRYPTION_KEY;
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

module.exports = { generateLinkingCode, generateInviteToken, encrypt, decrypt };

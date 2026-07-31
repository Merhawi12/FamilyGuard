const crypto = require('node:crypto');
const { env } = require('../config/env');
const logger = require('../utils/logger');

/**
 * Object storage for user-uploaded files (currently child profile photos),
 * backed by Google Cloud Storage.
 *
 * Uploads never pass through the API: the client asks for a short-lived signed
 * PUT URL and sends the bytes straight to the bucket. That keeps large request
 * bodies off the Cloud Run instances and out of the load balancer.
 *
 * Signing note — this is the part that bites on Cloud Run. V4 signing needs a
 * private key. Application Default Credentials on Cloud Run do not include one,
 * so the client falls back to the IAM `signBlob` API, which requires the service
 * account to hold `roles/iam.serviceAccountTokenCreator` *on itself*. Without
 * that grant every signing call fails with a 403 that does not mention signing.
 * infrastructure/gcp/iam.tf makes the grant.
 */

const ALLOWED_IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

let bucketHandle = null;

const getBucket = () => {
  if (bucketHandle) return bucketHandle;
  // Required lazily so environments without storage configured never pay the
  // import cost of the SDK.
  const { Storage } = require('@google-cloud/storage');
  const client = new Storage(env.gcp.projectId ? { projectId: env.gcp.projectId } : {});
  bucketHandle = client.bucket(env.storage.bucket);
  return bucketHandle;
};

const isEnabled = () => env.storage.provider === 'gcs' && !!env.storage.bucket;

/** Public URL for a stored object — Cloud CDN if configured, otherwise GCS. */
const publicUrl = (key) =>
  env.storage.publicBaseUrl
    ? `${env.storage.publicBaseUrl}/${key}`
    : `https://storage.googleapis.com/${env.storage.bucket}/${key}`;

/**
 * Keys are server-generated so a caller can never write outside its own prefix
 * or overwrite another tenant's object.
 */
const buildKey = (prefix, ownerId, extension) =>
  `${prefix}/${ownerId}/${crypto.randomUUID()}.${extension}`;

/**
 * @returns {{ uploadUrl: string, key: string, url: string, expiresIn: number }}
 * @throws  {Error} with `status` set when storage is off or the input is invalid.
 */
const createImageUploadUrl = async ({ prefix, ownerId, contentType, contentLength }) => {
  if (!isEnabled()) {
    const err = new Error('File storage is not configured');
    err.status = 503;
    throw err;
  }

  const extension = ALLOWED_IMAGE_TYPES[contentType];
  if (!extension) {
    const err = new Error(`Unsupported image type. Allowed: ${Object.keys(ALLOWED_IMAGE_TYPES).join(', ')}`);
    err.status = 400;
    throw err;
  }

  if (contentLength && Number(contentLength) > env.storage.maxUploadBytes) {
    const err = new Error(`File too large. Maximum size is ${Math.round(env.storage.maxUploadBytes / 1024 / 1024)} MB`);
    err.status = 413;
    throw err;
  }

  const key = buildKey(prefix, ownerId, extension);
  const ttlSeconds = env.storage.uploadUrlTtlSeconds;

  // contentType is bound into the signature: the browser must send exactly this
  // header, so a signed URL for a PNG cannot be reused to upload something else.
  const [uploadUrl] = await getBucket()
    .file(key)
    .getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + ttlSeconds * 1000,
      contentType,
    });

  return { uploadUrl, key, url: publicUrl(key), expiresIn: ttlSeconds };
};

/** Best-effort cleanup; a failed delete must not fail the request that caused it. */
const deleteObject = async (key) => {
  if (!isEnabled() || !key) return false;
  try {
    // ignoreNotFound: deleting an object that is already gone is a success as
    // far as the caller is concerned.
    await getBucket().file(key).delete({ ignoreNotFound: true });
    return true;
  } catch (err) {
    logger.error('Failed to delete stored object', { key, error: err.message });
    return false;
  }
};

/** Extracts the object key from a URL this service produced; null if foreign. */
const keyFromUrl = (url) => {
  if (!url) return null;
  const base = env.storage.publicBaseUrl || `https://storage.googleapis.com/${env.storage.bucket}`;
  return url.startsWith(`${base}/`) ? url.slice(base.length + 1) : null;
};

/**
 * Confirms a URL points at an object this service issued to *this* owner.
 *
 * Callers persist URLs that arrive in a request body, and later delete the URL
 * they replaced. Without this check a caller could store a URL naming someone
 * else's object and have the service delete it on the next update, so an
 * unverified URL must never reach the database.
 *
 * @returns {string|null} the object key, or null if the URL is not the owner's.
 */
const ownedKeyFromUrl = (url, { prefix, ownerId }) => {
  const key = keyFromUrl(url);
  if (!key) return null;

  const expected = `${prefix}/${ownerId}/`;
  if (!key.startsWith(expected)) return null;

  // Nothing may climb out of the owner's prefix.
  const remainder = key.slice(expected.length);
  return remainder && !remainder.includes('/') && !remainder.includes('..') ? key : null;
};

module.exports = {
  isEnabled,
  createImageUploadUrl,
  deleteObject,
  publicUrl,
  keyFromUrl,
  ownedKeyFromUrl,
  ALLOWED_IMAGE_TYPES,
};

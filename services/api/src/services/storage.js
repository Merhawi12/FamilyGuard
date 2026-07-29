const crypto = require('node:crypto');
const { env } = require('../config/env');
const logger = require('../utils/logger');

/**
 * Object storage for user-uploaded files (currently child profile photos).
 *
 * Uploads never pass through the API: the client asks for a short-lived
 * pre-signed PUT URL and sends the bytes straight to S3. That keeps large
 * request bodies off the Fargate tasks and out of the ALB.
 */

const ALLOWED_IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

let clients = null;

const getClients = () => {
  if (clients) return clients;
  const { S3Client, DeleteObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  clients = {
    s3: new S3Client({ region: env.aws.region }),
    DeleteObjectCommand,
    PutObjectCommand,
    getSignedUrl,
  };
  return clients;
};

const isEnabled = () => env.storage.provider === 's3' && !!env.storage.bucket;

/** Public URL for a stored object — CloudFront if configured, otherwise S3. */
const publicUrl = (key) =>
  env.storage.publicBaseUrl
    ? `${env.storage.publicBaseUrl}/${key}`
    : `https://${env.storage.bucket}.s3.${env.aws.region}.amazonaws.com/${key}`;

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

  const { s3, PutObjectCommand, getSignedUrl } = getClients();
  const key = buildKey(prefix, ownerId, extension);

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: env.storage.bucket, Key: key, ContentType: contentType }),
    { expiresIn: env.storage.uploadUrlTtlSeconds }
  );

  return { uploadUrl, key, url: publicUrl(key), expiresIn: env.storage.uploadUrlTtlSeconds };
};

/** Best-effort cleanup; a failed delete must not fail the request that caused it. */
const deleteObject = async (key) => {
  if (!isEnabled() || !key) return false;
  try {
    const { s3, DeleteObjectCommand } = getClients();
    await s3.send(new DeleteObjectCommand({ Bucket: env.storage.bucket, Key: key }));
    return true;
  } catch (err) {
    logger.error('Failed to delete stored object', { key, error: err.message });
    return false;
  }
};

/** Extracts the object key from a URL this service produced; null if foreign. */
const keyFromUrl = (url) => {
  if (!url) return null;
  const base = env.storage.publicBaseUrl || `https://${env.storage.bucket}.s3.${env.aws.region}.amazonaws.com`;
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

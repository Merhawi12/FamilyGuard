const { env } = require('../config/env');
const logger = require('../utils/logger');

/**
 * One `send({ to, subject, html, replyTo })` entry point over three transports:
 *
 *   ses   — Amazon SES v2, the production path in AWS (no SMTP credentials to
 *           rotate; IAM on the task role authorises the send).
 *   smtp  — any SMTP relay, for self-hosted or local testing.
 *   none  — logs the message instead of sending, so development and the test
 *           suite never touch the network.
 */

let transport = null;

const buildSesTransport = () => {
  // Required lazily so environments without the AWS SDK installed (or without
  // SES configured) never pay the import cost.
  const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
  const client = new SESv2Client({ region: env.aws.region });

  return async ({ to, subject, html, replyTo }) => {
    await client.send(
      new SendEmailCommand({
        FromEmailAddress: env.email.from,
        Destination: { ToAddresses: [to] },
        ReplyToAddresses: replyTo ? [replyTo] : undefined,
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: { Html: { Data: html, Charset: 'UTF-8' } },
          },
        },
      })
    );
  };
};

const buildSmtpTransport = () => {
  const nodemailer = require('nodemailer');
  const smtp = nodemailer.createTransport({
    host: env.email.smtp.host,
    port: env.email.smtp.port,
    secure: env.email.smtp.secure,
    auth: env.email.smtp.user ? { user: env.email.smtp.user, pass: env.email.smtp.pass } : undefined,
  });

  return async ({ to, subject, html, replyTo }) => {
    await smtp.sendMail({ from: env.email.from, to, subject, html, replyTo });
  };
};

const buildNoopTransport = () => async ({ to, subject }) => {
  logger.info('Email suppressed (no provider configured)', { to, subject });
};

const getTransport = () => {
  if (transport) return transport;

  if (env.email.provider === 'ses') transport = buildSesTransport();
  else if (env.email.provider === 'smtp' && env.email.smtp.host) transport = buildSmtpTransport();
  else transport = buildNoopTransport();

  return transport;
};

/** True when a real provider is wired up — callers use it to skip optional mail. */
const isEnabled = () => env.email.provider === 'ses' || (env.email.provider === 'smtp' && !!env.email.smtp.host);

/**
 * Never throws: a failed notification email must not fail the request that
 * triggered it. Returns whether the message actually went out.
 */
const send = async ({ to, subject, html, replyTo }) => {
  if (!to) return false;
  try {
    await getTransport()({ to, subject, html, replyTo });
    return true;
  } catch (err) {
    logger.error('Email send failed', { to, subject, error: err.message });
    return false;
  }
};

module.exports = { send, isEnabled };

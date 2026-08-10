/**
 * Auto-applied manual mock. otplib v13 depends on ESM-only packages
 * (`@scure/base`) that Jest's CJS runtime cannot parse, so the suite substitutes
 * this.
 *
 * **This mock must mirror otplib's real export shape.** The previous version
 * stubbed an `authenticator` singleton, which v13 removed — so the suite went on
 * passing against an API that no longer existed while every MFA route answered
 * 500 in production. A mock that invents its subject's interface tests nothing.
 * If the otplib major version changes, check this file against the real exports:
 * `node -e "console.log(Object.keys(require('otplib')))"`.
 *
 * `verify` resolves `{ valid: true }` by default; tests override it to exercise
 * the wrong-code and backup-code paths.
 */
const generateSecret = jest.fn(() => 'JBSWY3DPEHPK3PXP');

const generateURI = jest.fn(
  ({ issuer, label, secret }) =>
    `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}` +
    `?secret=${secret}&issuer=${encodeURIComponent(issuer)}`
);

const generate = jest.fn(async () => '123456');

/**
 * Matches the real library's contract, including its sharp edge: a token that is
 * not six digits makes otplib *throw*, it does not return `{ valid: false }`.
 * Reproducing that here is what keeps the backup-code path honest — a lenient
 * mock let a 500 on every backup-code sign-in pass as green.
 */
const verify = jest.fn(async ({ token }) => {
  if (!/^\d{6}$/.test(String(token))) {
    throw new Error(`Token must be 6 digits, got ${String(token).length}`);
  }
  return { valid: true };
});

module.exports = { generateSecret, generateURI, generate, verify };

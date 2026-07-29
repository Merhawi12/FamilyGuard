// Auto-applied manual mock. otplib v13 depends on ESM-only packages (@scure/base)
// that Jest's CJS runtime can't parse. We stub the surface mfaController uses with
// jest.fn()s so tests can drive TOTP verification outcomes (e.g. verify → false to
// exercise the backup-code path). verify/check default to true (happy path).
const authenticator = {
  generateSecret: jest.fn(() => 'TESTSECRET'),
  keyuri: jest.fn(() => 'otpauth://totp/Parentix:test?secret=TESTSECRET'),
  verify: jest.fn(() => true),
  check: jest.fn(() => true),
  options: {},
};

module.exports = { authenticator, totp: authenticator };

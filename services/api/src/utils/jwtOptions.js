/**
 * The algorithm every `jwt.verify` on this service accepts, stated once.
 *
 * Not a fix for a live hole — `jsonwebtoken` 9.0.3 already refuses both attacks
 * this defends against, and it was checked rather than assumed: a token signed
 * `alg: none` is rejected with "jwt signature is required", and an `RS256`
 * header verified against a string secret with "invalid algorithm". Omitting
 * `algorithms` on that version is safe today.
 *
 * It is here because *today* is doing a lot of work in that sentence. The
 * protection lives in the library's internals rather than in anything this
 * repository says, and it turns on the secret happening to be a string. Two
 * ordinary changes remove it: pinning an older `jsonwebtoken` (v8 accepted
 * `alg: none` by default), or moving `JWT_SECRET` to a key object or a KMS
 * handle, which is what a rotation story usually ends in. Either would restore
 * algorithm confusion silently — the tokens keep verifying, so nothing fails
 * until someone forges one.
 *
 * HS256 is what `jwt.sign` produces here (see utils/session.js — no `algorithm`
 * is passed, and that is the library default), so this is a statement of what is
 * already true rather than a change in behaviour.
 */
const JWT_VERIFY_OPTIONS = Object.freeze({ algorithms: ['HS256'] });

module.exports = { JWT_VERIFY_OPTIONS };

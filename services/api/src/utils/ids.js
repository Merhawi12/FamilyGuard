/**
 * Whether a value can be used as a UUID primary key in a query.
 *
 * This matters more than it looks. Every id column is `UUID`, and Postgres
 * rejects a malformed value outright — `invalid input syntax for type uuid` —
 * which surfaces as a 500 from a route that should have answered "not found".
 * SQLite has no UUID type and quietly matches nothing, so the whole class of
 * bug is invisible to a SQLite-only test run and only appears against Cloud SQL.
 *
 * Guarding before the query makes both engines answer the same way.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isUuid = (value) => typeof value === 'string' && UUID_PATTERN.test(value);

module.exports = { isUuid };

// Runs before any module (incl. config/db) is required. Forces a hermetic test
// environment: in-memory SQLite, deterministic secrets, no external services.
// Values are set here (not deleted) because config/db calls dotenv.config(), which
// fills only MISSING keys — setting them here prevents server/.env from leaking in.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.FIELD_ENCRYPTION_KEY = 'a'.repeat(64); // 32 bytes as 64 hex chars
process.env.DB_PATH = ':memory:';

// SQLite by default so the suite needs no external service. Point
// TEST_DATABASE_URL at a throwaway Postgres to run the very same tests against
// the engine production actually uses — SQLite accepts things Postgres rejects
// (json has no `=` operator there, for one), so a green SQLite run is not by
// itself evidence that Cloud SQL will accept the same SQL. See `npm run test:pg`.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || '';
if (process.env.TEST_DATABASE_URL) process.env.DB_SSL = 'false';
process.env.SMTP_HOST = '';           // email utils no-op without a host
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'; // makes the (mocked) Stripe client non-null
// Without a price the checkout route short-circuits to 503 before Stripe is
// ever called, so the happy path could not be tested at all.
process.env.STRIPE_PREMIUM_PRICE_ID = 'price_test_premium';
process.env.CLIENT_URL = 'http://localhost:3000';

// Sign in with Google is enabled in tests so the endpoint's real paths are
// exercised. This is a public client ID, not a credential — what makes the flow
// safe is that Google's signature over the ID token is checked against it, and
// tests/googleSignIn.test.js replaces that verification rather than reaching
// Google.
process.env.GOOGLE_CLIENT_ID = 'test-web-client.apps.googleusercontent.com';
process.env.ADMIN_URL = 'http://localhost:3001';

// Object storage is exercised against the manual Cloud Storage mock in
// __mocks__/@google-cloud/, so nothing here reaches the network.
process.env.STORAGE_PROVIDER = 'gcs';
process.env.GCS_BUCKET = 'parentix-uploads-test';
process.env.GCS_PUBLIC_BASE_URL = 'https://app.parentix.test/media';
process.env.GCP_PROJECT_ID = 'parentix-test';
process.env.GCP_REGION = 'us-central1';

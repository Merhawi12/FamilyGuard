// Runs before any module (incl. config/db) is required. Forces a hermetic test
// environment: in-memory SQLite, deterministic secrets, no external services.
// Values are set here (not deleted) because config/db calls dotenv.config(), which
// fills only MISSING keys — setting them here prevents server/.env from leaking in.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.FIELD_ENCRYPTION_KEY = 'a'.repeat(64); // 32 bytes as 64 hex chars
process.env.DB_PATH = ':memory:';
process.env.DATABASE_URL = '';        // force the SQLite branch in config/db
process.env.SMTP_HOST = '';           // email utils no-op without a host
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'; // makes the (mocked) Stripe client non-null
process.env.CLIENT_URL = 'http://localhost:3000';
process.env.ADMIN_URL = 'http://localhost:3001';

// Object storage is exercised against the manual AWS SDK mocks in __mocks__/,
// so nothing here reaches the network.
process.env.STORAGE_PROVIDER = 's3';
process.env.S3_BUCKET = 'parentix-uploads-test';
process.env.S3_PUBLIC_BASE_URL = 'https://app.parentix.test/media';
process.env.AWS_REGION = 'us-east-2';

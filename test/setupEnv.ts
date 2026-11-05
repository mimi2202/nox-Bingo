// Server modules read these when imported. Nothing here reaches a real service:
// the tests only touch in-memory config and an embedded database.
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.ADMIN_JWT_SECRET = 'test-admin-jwt-secret-test-admin-jwt-secret';
process.env.ADMIN_PASSWORD = 'test-admin-password';

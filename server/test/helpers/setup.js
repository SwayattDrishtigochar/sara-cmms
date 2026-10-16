// Runs before every test file, before any app module reads the environment.
process.env.NODE_ENV = 'test';
process.env.AI_MOCK = 'true';
try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch {
  // CI passes variables directly
}
// The test database replaces any database path in MONGO_TEST_URI; `?options` (authSource, replicaSet) stay.
const [hosts, options] = (process.env.MONGO_TEST_URI || 'mongodb://localhost:27017').split('?');
const root = hosts.replace(/^([a-z+]+:\/\/[^/]+).*$/, '$1');
// SARA_TEST_DB lets parallel runs (e.g. several agents) use separate databases.
const prefix = process.env.SARA_TEST_DB ?? 'sara_test';
process.env.MONGO_URI = `${root}/${prefix}_${process.env.VITEST_POOL_ID ?? '0'}${options ? `?${options}` : ''}`;
process.env.JWT_SECRET ||= 'test-secret-test-secret-test-secret';

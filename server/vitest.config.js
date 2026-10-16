import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/helpers/setup.js'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    pool: 'forks',
  },
});

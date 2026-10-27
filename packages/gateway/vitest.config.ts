import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/live/**', 'node_modules/**'],
    environment: 'node',
    testTimeout: 15_000,
    hookTimeout: 15_000,
    pool: 'forks',
    maxWorkers: 2,
  },
});

import { defineConfig } from 'vitest/config';

/** Opt-in live suite against the real opencode bridge: `pnpm test:live` (≤ 6 real model calls). */
export default defineConfig({
  test: {
    include: ['test/live/**/*.test.ts'],
    environment: 'node',
    testTimeout: 240_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    silent: false,
    reporters: ['verbose'],
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    hookTimeout: 120000,
    testTimeout: 120000,
    coverage: {
      provider: 'v8',
      include: ['src/domain/**/*.ts', 'src/http/auth.ts', 'src/http/app.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: { lines: 80, functions: 80, statements: 80 },
    },
  },
});

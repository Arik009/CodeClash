import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The isolation check asserts that no cc-run container is still up.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/decide.ts', 'src/slots.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: { lines: 80, functions: 80, statements: 80 },
    },
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    env: { AIC_NO_BROWSER: '1' },
    execArgv: ['--disable-warning=ExperimentalWarning'],
  },
});

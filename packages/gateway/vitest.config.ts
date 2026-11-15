import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Windows 文件宿主并发冷启动会挤占既有回合时限；串行测试文件，不放宽产品时限和安全断言。
    maxWorkers: process.platform === 'win32' ? 1 : 2,
    env: { AIC_NO_BROWSER: '1' },
    execArgv: ['--disable-warning=ExperimentalWarning'],
  },
});

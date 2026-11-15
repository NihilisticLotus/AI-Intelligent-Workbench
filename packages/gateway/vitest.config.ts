import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // git 与 Windows 文件宿主均为真实离线子进程；限制并行文件数，避免挤占既有回合时限。
    maxWorkers: 2,
    env: { AIC_NO_BROWSER: '1' },
    execArgv: ['--disable-warning=ExperimentalWarning'],
  },
});

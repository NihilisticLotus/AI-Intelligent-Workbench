// 网页工作台的 Vite 配置。
// 开发时：浏览器访问 Vite（默认 http://127.0.0.1:5173），/api 代理到本机 Gateway（含 WebSocket）。
// Gateway 那边需要用环境变量 AIC_DEV_ORIGIN=http://127.0.0.1:5173 放行这个来源。
// 构建：输出到 apps/web/dist，由 Gateway 托管。
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const gateway = process.env.AIC_GATEWAY ?? 'http://127.0.0.1:17890';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      // changeOrigin 把 Host 改成 Gateway 自己的地址，满足 Host 校验；Origin 保持 Vite 地址，由 AIC_DEV_ORIGIN 放行
      '/api': { target: gateway, changeOrigin: true, ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});

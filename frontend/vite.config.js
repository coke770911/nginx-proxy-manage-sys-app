import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      // SSE 也走此代理；後端預設 3000
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
});

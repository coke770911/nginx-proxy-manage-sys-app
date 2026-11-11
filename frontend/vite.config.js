import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

// 前端只負責編譯；產出直接放進後端靜態資料夾 backend/public，由後端單一 port 提供
export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: fileURLToPath(new URL('../backend/public', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});

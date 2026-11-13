import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

// 版本號取自 package.json（npm run release 會同步），顯示在頁尾
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// 前端只負責編譯；產出直接放進後端靜態資料夾 backend/public，由後端單一 port 提供
export default defineConfig({
  plugins: [vue()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: {
    outDir: fileURLToPath(new URL('../backend/public', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});

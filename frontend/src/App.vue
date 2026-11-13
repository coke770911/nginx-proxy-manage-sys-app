<script setup>
import Dashboard from './views/Dashboard.vue';
import Login from './views/Login.vue';
import { session } from './api';

const version = __APP_VERSION__;
</script>

<template>
  <div class="app-shell">
    <main class="app-main">
      <Dashboard v-if="session.token" />
      <Login v-else />
    </main>
    <footer class="app-footer">
      <span>Nginx HA Proxy Manager v{{ version }}</span>
      <span class="sep">｜</span>
      <span>反向代理伺服器節點管理系統</span>
      <span class="sep">｜</span>
      <span>亞東科技大學 圖書資訊處 © 2026 建置</span>
    </footer>
  </div>
</template>

<style>
body {
  margin: 0;
  background: #f4f6fa;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft JhengHei', 'PingFang TC', sans-serif;
}
.app-shell { min-height: 100vh; display: flex; flex-direction: column; }
.app-main { flex: 1; }
.app-footer {
  padding: 14px 16px 18px;
  text-align: center;
  font-size: 12px;
  color: #909399;
  border-top: 1px solid #e4e7ed;
  line-height: 1.8;
}
.app-footer .sep { margin: 0 8px; color: #c0c4cc; }
@media (max-width: 600px) {
  .app-footer span { display: block; }
  .app-footer .sep { display: none; }
}
</style>

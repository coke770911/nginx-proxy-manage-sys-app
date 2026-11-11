'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const config = require('./config');
const { sequelize } = require('./models');
const proxyRoutes = require('./routes/proxyRoutes');
const auth = require('./routes/authRoutes');
const accountRoutes = require('./routes/accountRoutes');
const healthService = require('./services/healthService');

const app = express();
app.disable('x-powered-by');
// 預設只信任本機反向代理的 X-Forwarded-For，避免偽造來源 IP 繞過登入鎖定
app.set('trust proxy', config.trustProxy);
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use('/api/auth', auth.router);
app.use('/api/accounts', auth.requireAuth, accountRoutes);
app.use('/api', auth.requireAuth, proxyRoutes);
app.use('/api', (req, res) => res.status(404).json({ message: '找不到此 API' }));

// 前端 build 結果（frontend 執行 npm run build 會輸出到 backend/public），與 API 共用同一個 port
const publicDir = path.resolve(__dirname, '../public');
if (fs.existsSync(path.join(publicDir, 'index.html'))) {
  app.use(express.static(publicDir));
  app.get(/^\/(?!api(\/|$)).*/, (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
} else {
  console.warn('[web] 找不到 backend/public/index.html，請先在 frontend 執行 npm run build');
}

(async () => {
  if (!config.auth.jwtSecret || config.auth.jwtSecret.length < 32) {
    console.error('[auth] JWT_SECRET 未設定或長度不足 32 字元，請於 backend/.env 設定');
    process.exit(1);
  }
  if (!config.auth.adminAccounts.length) console.warn('[auth] ADMIN_ACCOUNTS 未設定，只有「帳號管理」中啟用的帳號可以登入');
  if (!config.soap.url) console.warn('[auth] SOAP_URL 未設定，登入驗證將無法使用');
  try {
    await sequelize.authenticate();
    console.log('[db] SQL Server 連線成功');
  } catch (e) {
    console.error('[db] SQL Server 連線失敗：', e.message);
    process.exit(1);
  }
  app.listen(config.port, () => console.log(`[web] Nginx HA Proxy Manager 啟動：http://0.0.0.0:${config.port}`));
  healthService.startScheduler();
})();

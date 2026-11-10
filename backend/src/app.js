'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const config = require('./config');
const { sequelize } = require('./models');
const proxyRoutes = require('./routes/proxyRoutes');
const healthService = require('./services/healthService');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '1mb' }));

/** 簡易 API Token 驗證（設定 API_TOKEN 後啟用）；SSE 因 EventSource 無法帶標頭，可用 ?token= */
function authGuard(req, res, next) {
  if (!config.apiToken) return next();
  const given = String(req.get('x-api-token') || req.query.token || '');
  const a = Buffer.from(given);
  const b = Buffer.from(config.apiToken);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  return res.status(401).json({ message: '未授權：缺少或錯誤的 API Token' });
}

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use('/api', authGuard, proxyRoutes);

// 正式環境：直接由 Express 提供前端 build 結果
const dist = path.resolve(__dirname, '../../frontend/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

(async () => {
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

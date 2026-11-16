'use strict';
/**
 * 登入與 JWT 驗證
 * 登入條件：帳號在可登入名單內（ADMIN_ACCOUNTS + 帳號管理）「且」通過 portal 認證 REST API 帳密驗證。
 * 登入成功後以 userDataConnect 取得姓名與單位放入 JWT（查無資料不影響登入）。
 * 每次 API 請求都會重新檢查白名單，帳號自 .env 移除並重啟後，舊 Token 立即失效。
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config');
const portalAuth = require('../services/portalAuth');
const audit = require('../services/auditService');
const accounts = require('../services/accountService');

const router = express.Router();
const ISSUER = 'nginx-ha-proxy-manager';


/* ---------------------------------------------- 登入失敗鎖定（記憶體，依 IP + 帳號） */
const failures = new Map(); // key -> { count, until }
const lockKey = (req, u) => `${req.ip}|${String(u).toLowerCase()}`;

function lockedMinutes(key) {
  const f = failures.get(key);
  if (!f || !f.until) return 0;
  const left = f.until - Date.now();
  if (left <= 0) { failures.delete(key); return 0; }
  return Math.ceil(left / 60000);
}

function recordFailure(key) {
  const f = failures.get(key) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= config.auth.maxFailures) {
    f.until = Date.now() + config.auth.lockMinutes * 60000;
    f.count = 0;
  }
  failures.set(key, f);
}

setInterval(() => {
  const now = Date.now();
  for (const [k, f] of failures) if (f.until && f.until < now) failures.delete(k);
}, 10 * 60000).unref();

/* ---------------------------------------------------------------- API */
router.post('/login', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!username || !password || username.length > 100 || password.length > 256) {
    return res.status(400).json({ message: '請輸入帳號與密碼' });
  }

  const key = lockKey(req, username);
  const mins = lockedMinutes(key);
  if (mins) {
    await audit.record(req, { action: 'LOGIN_FAILED', targetType: 'AUTH', username, success: false, detail: { reason: '登入失敗次數過多，暫時鎖定' } });
    return res.status(429).json({ message: `登入失敗次數過多，請 ${mins} 分鐘後再試` });
  }

  // 不在白名單者不送認證服務，但回應訊息與帳密錯誤相同，避免帳號列舉
  let ok = false;
  let displayName = '';
  const source = await accounts.loginSource(username);
  if (source) {
    try {
      ({ ok, displayName } = await portalAuth.verify(username, password));
    } catch (e) {
      console.error(`[auth] 認證服務錯誤（${e.code || 'ERROR'}）：${e.message}`);
      await audit.record(req, { action: 'LOGIN_FAILED', targetType: 'AUTH', username, success: false, detail: { reason: '認證服務錯誤', code: e.code } });
      const status = e.code === 'NOT_CONFIGURED' ? 503 : e.code === 'RATE_LIMITED' ? 429 : 502;
      return res.status(status).json({ message: `認證服務無法使用：${e.message}` });
    }
  }

  if (!ok) {
    recordFailure(key);
    console.warn(`[auth] 登入失敗：${username} @ ${req.ip}`);
    await audit.record(req, { action: 'LOGIN_FAILED', targetType: 'AUTH', username, success: false, detail: { reason: source ? '密碼錯誤' : '不在可登入帳號名單' } });
    return res.status(401).json({ message: '帳號或密碼錯誤，或無權限登入此系統' });
  }

  failures.delete(key);
  // 姓名與單位：查無資料或查詢失敗不影響登入，退回使用 DisplayName
  const profile = await portalAuth.getUserData(username);
  const name = (profile?.name || displayName || '').slice(0, 100);
  const departments = (profile?.departments || []).slice(0, 10).map((d) => d.slice(0, 100));
  const token = jwt.sign({ sub: username, name, dept: departments }, config.auth.jwtSecret, {
    expiresIn: config.auth.jwtExpiresIn, issuer: ISSUER, algorithm: 'HS256',
  });
  console.log(`[auth] 登入成功：${username} @ ${req.ip}`);
  if (source === 'db') await accounts.touchLogin(username);
  await audit.record(req, { action: 'LOGIN', targetType: 'AUTH', username, detail: { source: source === 'env' ? '.env 特權帳號' : '帳號管理', name: name || undefined } });
  return res.json({ token, username, name, departments, expiresIn: config.auth.jwtExpiresIn });
});

/** JWT 驗證中介層：Authorization: Bearer <token>；SSE（EventSource 無法帶標頭）可用 ?token= */
async function requireAuth(req, res, next) {
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : String(req.query.token || '');
  if (!token) return res.status(401).json({ message: '請先登入' });
  let payload;
  try {
    payload = jwt.verify(token, config.auth.jwtSecret, { issuer: ISSUER, algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ message: '登入已逾時，請重新登入' });
  }
  try {
    if (!(await accounts.loginSource(payload.sub))) return res.status(403).json({ message: '此帳號已無權限使用本系統' });
  } catch (e) {
    return res.status(503).json({ message: `無法確認帳號權限：${e.message}` });
  }
  req.user = {
    username: payload.sub,
    name: typeof payload.name === 'string' ? payload.name : '',
    departments: Array.isArray(payload.dept) ? payload.dept : [],
  };
  return next();
}

router.get('/me', requireAuth, (req, res) => res.json(req.user));

module.exports = { router, requireAuth };

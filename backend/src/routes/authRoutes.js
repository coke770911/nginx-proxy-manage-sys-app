'use strict';
/**
 * 登入與 JWT 驗證
 * 登入條件：帳號在 .env ADMIN_ACCOUNTS 白名單內「且」通過 SOAP 帳密驗證。
 * 每次 API 請求都會重新檢查白名單，帳號自 .env 移除並重啟後，舊 Token 立即失效。
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config');
const soapAuth = require('../services/soapAuth');
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

  // 不在白名單者不送 SOAP，但回應訊息與帳密錯誤相同，避免帳號列舉
  let ok = false;
  const source = await accounts.loginSource(username);
  if (source) {
    try {
      ok = await soapAuth.verify(username, password);
    } catch (e) {
      console.error('[auth] SOAP 認證服務錯誤：', e.message);
      await audit.record(req, { action: 'LOGIN_FAILED', targetType: 'AUTH', username, success: false, detail: { reason: '認證服務錯誤' } });
      return res.status(502).json({ message: `認證服務無法使用：${e.message}` });
    }
  }

  if (!ok) {
    recordFailure(key);
    console.warn(`[auth] 登入失敗：${username} @ ${req.ip}`);
    await audit.record(req, { action: 'LOGIN_FAILED', targetType: 'AUTH', username, success: false, detail: { reason: source ? '密碼錯誤' : '不在可登入帳號名單' } });
    return res.status(401).json({ message: '帳號或密碼錯誤，或無權限登入此系統' });
  }

  failures.delete(key);
  const token = jwt.sign({ sub: username }, config.auth.jwtSecret, {
    expiresIn: config.auth.jwtExpiresIn, issuer: ISSUER, algorithm: 'HS256',
  });
  console.log(`[auth] 登入成功：${username} @ ${req.ip}`);
  if (source === 'db') await accounts.touchLogin(username);
  await audit.record(req, { action: 'LOGIN', targetType: 'AUTH', username, detail: { source: source === 'env' ? '.env 特權帳號' : '帳號管理' } });
  return res.json({ token, username, expiresIn: config.auth.jwtExpiresIn });
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
  req.user = { username: payload.sub };
  return next();
}

router.get('/me', requireAuth, (req, res) => res.json({ username: req.user.username }));

module.exports = { router, requireAuth };

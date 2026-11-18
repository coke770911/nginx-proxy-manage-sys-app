'use strict';
/**
 * 校內 portal 認證 REST API
 * - 帳密驗證：POST { Account, Password }，Header X-Auth-Key，回應 Ok === true 才算成功
 * - 姓名 / 單位：POST { Action: 'userDataConnect', Account }，查無資料或失敗不影響登入
 * - API 金鑰只從 .env AUTH_API_KEY 讀取，不寫入程式、不回傳前端、不寫入 Log
 */
const http = require('http');
const https = require('https');
const config = require('../config');

/** 服務端錯誤碼 → 中文訊息（顯示給登入者與寫入 Log） */
const CODE_MESSAGES = {
  INVALID_REQUEST: '認證服務回報請求格式錯誤（缺少必要參數）',
  API_KEY_INVALID: '認證服務 API 金鑰錯誤或未提供，請管理者檢查 backend/.env 的 AUTH_API_KEY',
  IP_DENIED: '本系統主機 IP 不在認證服務的白名單內，請聯絡認證服務管理者',
  PATH_MISMATCH: '認證服務網址路徑不符，請檢查 backend/.env 的 AUTH_API_URL',
  METHOD_NOT_ALLOWED: '認證服務不允許此呼叫方法，請聯絡認證服務管理者',
  RATE_LIMITED: '認證服務請求過於頻繁，請稍後再試',
  VENDOR_DISABLED: '認證服務已停用本系統的存取，請聯絡認證服務管理者',
  INTERNAL_ERROR: '認證服務內部錯誤，請稍後再試',
};

class AuthServiceError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || 'SERVICE_ERROR';
  }
}

function assertConfigured() {
  const a = config.authApi;
  if (!a.url) throw new AuthServiceError('尚未設定認證服務網址（backend/.env 的 AUTH_API_URL），無法登入', 'NOT_CONFIGURED');
  if (!a.key) throw new AuthServiceError('尚未設定認證服務 API 金鑰（backend/.env 的 AUTH_API_KEY），無法登入', 'NOT_CONFIGURED');
}

function postJson(payload) {
  const a = config.authApi;
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const u = new URL(a.url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Accept: 'application/json',
        'X-Auth-Key': a.key,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: a.timeoutMs,
      ...(u.protocol === 'https:' ? { rejectUnauthorized: a.rejectUnauthorized } : {}),
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 256 * 1024) { req.destroy(new AuthServiceError('認證服務回應過大')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(text); } catch { /* 非 JSON，由呼叫端處理 */ }
        resolve({ status: res.statusCode, data, text });
      });
    });
    req.on('timeout', () => req.destroy(new AuthServiceError(`認證服務逾時（超過 ${a.timeoutMs} ms 未回應）`, 'TIMEOUT')));
    req.on('error', (e) => reject(e instanceof AuthServiceError
      ? e
      : new AuthServiceError(`無法連線認證服務：${e.code || e.message}`, 'CONNECT_FAILED')));
    req.end(body);
  });
}

/** 依 HTTP 狀態與 Code 產生中文錯誤訊息 */
function describe(status, data) {
  const code = data?.Code ? String(data.Code) : '';
  if (CODE_MESSAGES[code]) return { code, message: CODE_MESSAGES[code] };
  const byStatus = { 400: 'INVALID_REQUEST', 401: 'API_KEY_INVALID', 429: 'RATE_LIMITED', 503: 'VENDOR_DISABLED', 500: 'INTERNAL_ERROR' };
  if (byStatus[status]) return { code: code || byStatus[status], message: CODE_MESSAGES[byStatus[status]] };
  if (status === 403) return { code: code || 'FORBIDDEN', message: '認證服務拒絕存取（來源 IP、路徑或方法不被允許）' };
  return { code: code || `HTTP_${status}`, message: `認證服務回應異常（HTTP ${status}${code ? `，${code}` : ''}）` };
}

/**
 * 驗證帳號密碼
 * @returns {Promise<{ ok: boolean, displayName: string }>} 帳密錯誤回 ok=false；服務 / 設定問題丟出 AuthServiceError
 */
async function verify(account, password) {
  assertConfigured();
  const { status, data } = await postJson({ Account: account, Password: password });
  if (!data || typeof data !== 'object') {
    throw new AuthServiceError(`認證服務回應不是有效的 JSON（HTTP ${status}）`, 'BAD_RESPONSE');
  }
  if (data.Ok === true) {
    // 帳密驗證回應本身帶的姓名 / 單位（欄位名稱相容幾種寫法）；記錄回應欄位名稱（不含值）以利對照
    console.log(`[auth] 認證回應欄位：${Object.keys(data).join(', ')}`);
    const pick = (...keys) => keys.map((k) => data[k] ?? data.Data?.[k] ?? data.User?.[k]).find((v) => v !== undefined && v !== null && v !== '');
    const dep = pick('Department', 'Departments', 'Dept', 'DeptName', 'Unit', 'UnitName');
    const departments = (Array.isArray(dep) ? dep : [dep]).map((s) => String(s ?? '').trim()).filter(Boolean);
    return { ok: true, displayName: String(pick('DisplayName', 'Name') || '').trim(), departments };
  }
  if (data.Code === 'INVALID_CREDENTIALS') return { ok: false, displayName: '' };
  const d = describe(status, data);
  throw new AuthServiceError(d.message, d.code);
}

/**
 * 查詢姓名與單位（userDataConnect）
 * @returns {Promise<{ name: string, departments: string[] } | null>} 查無資料或任何錯誤都回 null（不影響登入）
 */
async function getUserData(account) {
  try {
    assertConfigured();
    const { status, data } = await postJson({ Action: 'userDataConnect', Account: account });
    if (data?.Ok === true) {
      const departments = (Array.isArray(data.Department) ? data.Department : [data.Department])
        .map((s) => String(s || '').trim()).filter(Boolean);
      return { name: String(data.Name || '').trim(), departments };
    }
    if (data?.Code !== 'NOT_FOUND') console.warn(`[auth] 查詢姓名與單位失敗：${describe(status, data).message}`);
  } catch (e) {
    console.warn(`[auth] 查詢姓名與單位失敗：${e.message}`);
  }
  return null;
}

module.exports = { verify, getUserData, assertConfigured, AuthServiceError, CODE_MESSAGES };

'use strict';
/**
 * SOAP 帳號密碼驗證
 * - 依 .env 的 SOAP_* 設定組出 SOAP Envelope，POST 到認證服務
 * - HTTP 200、非 SOAP Fault、且回應內容符合 SOAP_SUCCESS_REGEX 才視為驗證成功
 * - 帳號密碼一律經 XML 跳脫後才放入 Envelope，避免 XML 注入
 */
const http = require('http');
const https = require('https');
const config = require('../config');

const xmlEscape = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

/** 產生 SOAP Envelope：有自訂範本用範本，否則依 METHOD / NAMESPACE / 欄位名稱組出 */
function buildEnvelope(username, password) {
  const s = config.soap;
  const vars = { username: xmlEscape(username), password: xmlEscape(password) };
  if (s.requestTemplate) {
    return s.requestTemplate.replace(/\{\{\s*(username|password)\s*\}\}/g, (_, k) => vars[k]);
  }
  const envNs = s.version === '1.2'
    ? 'http://www.w3.org/2003/05/soap-envelope'
    : 'http://schemas.xmlsoap.org/soap/envelope/';
  return '<?xml version="1.0" encoding="utf-8"?>'
    + `<soap:Envelope xmlns:soap="${envNs}">`
    + '<soap:Body>'
    + `<${s.method} xmlns="${xmlEscape(s.namespace)}">`
    + `<${s.userField}>${vars.username}</${s.userField}>`
    + `<${s.passField}>${vars.password}</${s.passField}>`
    + `</${s.method}>`
    + '</soap:Body></soap:Envelope>';
}

function post(url, body, headers, timeoutMs, rejectUnauthorized) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs,
      ...(u.protocol === 'https:' ? { rejectUnauthorized } : {}),
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 1024 * 1024) { req.destroy(new Error('SOAP 回應過大')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('SOAP 認證服務逾時')));
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * 驗證帳號密碼
 * @returns {Promise<boolean>} true = 驗證成功；服務無法連線時丟出錯誤
 */
async function verify(username, password) {
  const s = config.soap;
  if (!s.url) throw new Error('尚未設定 SOAP_URL，無法進行登入驗證');

  const body = buildEnvelope(username, password);
  const headers = s.version === '1.2'
    ? { 'Content-Type': `application/soap+xml; charset=utf-8${s.action ? `; action="${s.action}"` : ''}` }
    : { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${s.action}"` };

  const { status, text } = await post(s.url, body, headers, s.timeoutMs, s.rejectUnauthorized);
  if (/<(\w+:)?Fault[\s>]/.test(text) || status !== 200) {
    console.warn(`[soap] 認證服務回傳錯誤（HTTP ${status}）`);
    return false;
  }
  const ok = s.successRegex.test(text);
  if (!ok) {
    // 只記錄 Body 內文字（不含密碼），方便依實際回傳調整 SOAP_SUCCESS_REGEX
    const body = (text.match(/<(?:\w+:)?Body[^>]*>([\s\S]*)<\/(?:\w+:)?Body>/) || [, text])[1];
    console.warn(`[soap] 驗證未通過，服務回應：${body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`);
  }
  return ok;
}

module.exports = { verify, buildEnvelope, xmlEscape };

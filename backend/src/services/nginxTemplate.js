'use strict';
/**
 * Nginx 設定檔生成器 (Template Engine)
 * 每條 DomainRule → 一個 /etc/nginx/sites-managed/<domain>.conf
 *
 * 所有會被插入設定檔的欄位都先經 validateRule() 白名單驗證，避免設定注入。
 * HTTP/2 寫法依 .env NGINX_HTTP2_SYNTAX：
 *   modern（預設，nginx ≥ 1.25.1，如 Ubuntu 26.04）→ `listen 443 ssl;` + `http2 on;`
 *   legacy（nginx < 1.25.1，如 Ubuntu 24.04 的 1.24）→ `listen 443 ssl http2;`
 */
const config = require('../config');

const DOMAIN_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/;
const SIZE_RE = /^\d{1,5}[kKmMgG]?$/;

const confFileName = (domain) => `${String(domain).toLowerCase().replace(/^\*\./, '_wildcard.')}.conf`;
const certRemotePaths = (certId) => ({
  crt: `${config.ssh.sslDir}/cert_${certId}.crt`,
  key: `${config.ssh.sslDir}/cert_${certId}.key`,
});

/** 回傳錯誤訊息陣列；空陣列 = 通過 */
function validateRule(r) {
  const errs = [];
  if (!r.DomainName || !DOMAIN_RE.test(r.DomainName)) errs.push('來源網域格式不正確（例：portal.aeust.edu.tw）');
  if (!r.TargetIp || !HOST_RE.test(r.TargetIp)) errs.push('目標後端 IP/主機名稱格式不正確');
  const port = Number(r.TargetPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) errs.push('目標 Port 必須為 1–65535');
  if (!r.CertificateId) errs.push('必須綁定 SSL 憑證');
  if (!SIZE_RE.test(String(r.ClientMaxBodySize || ''))) errs.push('上傳檔案上限格式不正確（例：50M、1G、0 代表不限制）');
  const snippet = r.CustomNginxSnippet || '';
  if (snippet) {
    if (snippet.length > 20000) errs.push('自訂 Nginx 語法過長（上限 20000 字元）');
    let depth = 0;
    for (const ch of snippet) {
      if (ch === '{') depth += 1;
      if (ch === '}') depth -= 1;
      if (depth < 0) break;
    }
    if (depth !== 0) errs.push('自訂 Nginx 語法的大括號 { } 未成對，可能破壞整份設定');
  }
  return errs;
}

const indent = (text, n = 4) =>
  String(text)
    .split('\n')
    .map((l) => (l.trim() ? ' '.repeat(n) + l.trimEnd() : ''))
    .join('\n');

const maintenanceHtml = (domain) =>
  '<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1"><title>系統維護中</title>' +
  '<style>body{font-family:sans-serif;background:#f5f7fa;color:#333;display:flex;align-items:center;' +
  'justify-content:center;min-height:100vh;margin:0}main{text-align:center;padding:2rem}' +
  'h1{font-size:1.8rem}p{color:#666}</style></head><body><main><h1>系統維護中</h1>' +
  `<p>${domain} 目前進行維護作業，請稍後再試。</p>` +
  '<p>System under maintenance. Please try again later.</p></main></body></html>';

function renderConf(rule) {
  const errs = validateRule(rule);
  if (errs.length) throw new Error(`規則 ${rule.DomainName || '?'} 驗證失敗：${errs.join('；')}`);

  const domain = rule.DomainName.toLowerCase();
  const ws = !!rule.EnableWebSocket;
  const upstream = `http://${rule.TargetIp}:${rule.TargetPort}`;
  const { crt, key } = certRemotePaths(rule.CertificateId);
  const connVar = `$conn_upgrade_r${rule.Id || 0}`;

  const healthLocation = [
    'location = /f5-health-check {',
    '    access_log off;',
    '    default_type text/plain;',
    '    return 200 "OK\\n";',
    '}',
  ].join('\n');

  const proxyLocation = [
    'location / {',
    `    proxy_pass ${upstream};`,
    '    proxy_http_version 1.1;',
    '    proxy_set_header Host $host;',
    '    proxy_set_header X-Real-IP $remote_addr;',
    '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '    proxy_set_header X-Forwarded-Proto $scheme;',
    '    proxy_set_header X-Forwarded-Host $host;',
    ...(ws
      ? ['    proxy_set_header Upgrade $http_upgrade;', `    proxy_set_header Connection ${connVar};`]
      : ['    proxy_set_header Connection "";']),
    '    proxy_connect_timeout 10s;',
    '    proxy_send_timeout 300s;',
    `    proxy_read_timeout ${ws ? '3600s' : '300s'};`,
    '}',
  ].join('\n');

  const maintenanceLocation = [
    'location / {',
    '    default_type text/html;',
    '    charset utf-8;',
    '    add_header Retry-After 3600 always;',
    '    add_header Cache-Control "no-store" always;',
    `    return 503 '${maintenanceHtml(domain)}';`,
    '}',
  ].join('\n');

  const trafficLocation = rule.IsMaintenance ? maintenanceLocation : proxyLocation;
  const bodySize = `client_max_body_size ${rule.ClientMaxBodySize};`;

  const out = [];
  out.push('# =====================================================================');
  out.push('# Managed by Nginx HA Proxy Manager — 請勿手動修改，下次部署會被覆寫');
  out.push(`# Domain : ${domain}`);
  out.push(`# Rule   : #${rule.Id || '-'}  →  ${upstream}${rule.IsMaintenance ? '   [MAINTENANCE MODE]' : ''}`);
  out.push(`# Remark : ${String(rule.Remark || '').replace(/[\r\n]+/g, ' ')}`);
  out.push('# =====================================================================');
  out.push('');

  if (ws && !rule.IsMaintenance) {
    out.push('# WebSocket：僅在帶 Upgrade 標頭時才送 Connection: upgrade，其餘維持 keepalive');
    out.push(`map $http_upgrade ${connVar} {`);
    out.push('    default upgrade;');
    out.push("    ''      close;");
    out.push('}');
    out.push('');
  }

  // ---- Port 80 ----
  out.push('server {');
  out.push('    listen 80;');
  out.push(`    server_name ${domain};`);
  out.push('');
  out.push(indent(healthLocation));
  out.push('');
  if (rule.ForceHttps) {
    out.push('    location / {');
    out.push('        return 301 https://$host$request_uri;');
    out.push('    }');
  } else {
    out.push(indent(bodySize));
    out.push('');
    out.push(indent(trafficLocation));
  }
  out.push('}');
  out.push('');

  // ---- Port 443 ----
  out.push('server {');
  if (config.nginx.http2Syntax === 'legacy') {
    out.push('    listen 443 ssl http2;');
  } else {
    out.push('    listen 443 ssl;');
    out.push('    http2 on;');
  }
  out.push(`    server_name ${domain};`);
  out.push('');
  out.push(`    ssl_certificate     ${crt};`);
  out.push(`    ssl_certificate_key ${key};`);
  out.push('    ssl_protocols TLSv1.2 TLSv1.3;');
  out.push('    ssl_prefer_server_ciphers off;');
  out.push('    ssl_session_cache shared:SSL:10m;');
  out.push('    ssl_session_timeout 1d;');
  out.push('    ssl_session_tickets off;');
  out.push('');
  out.push(indent(bodySize));
  out.push('');
  out.push(indent(healthLocation));
  out.push('');
  if (rule.CustomNginxSnippet && rule.CustomNginxSnippet.trim()) {
    out.push('    # ---- 自訂 Nginx 語法 (CustomNginxSnippet) ----');
    out.push(indent(rule.CustomNginxSnippet.trim()));
    out.push('    # ---- 自訂語法結束 ----');
    out.push('');
  }
  out.push(indent(trafficLocation));
  out.push('}');
  out.push('');

  return out.join('\n');
}

module.exports = { validateRule, renderConf, confFileName, certRemotePaths };

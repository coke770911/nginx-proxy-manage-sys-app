'use strict';
/**
 * Nginx 設定檔生成器 (Template Engine)
 * 每條 DomainRule → 一個 /etc/nginx/sites-managed/<domain>.conf
 *
 * 所有會被插入設定檔的欄位都先經 validateRule() 白名單驗證，避免設定注入。
 * 負載平衡：每條規則產生一個 upstream（rule<Id>_backend），成員來自 RuleUpstreams；
 *   分配方式 round_robin（預設）/ least_conn / cookie（hash $cookie_<名稱> consistent），
 *   每台 max_fails=3 fail_timeout=10s，連線失敗或逾時自動改送下一台（不重送 POST 等非冪等請求）。
 * HTTP/2 寫法依 .env NGINX_HTTP2_SYNTAX：
 *   modern（預設，nginx ≥ 1.25.1，如 Ubuntu 26.04）→ `listen 443 ssl;` + `http2 on;`
 *   legacy（nginx < 1.25.1，如 Ubuntu 24.04 的 1.24）→ `listen 443 ssl http2;`
 */
const config = require('../config');

const DOMAIN_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/;
const SIZE_RE = /^\d{1,5}[kKmMgG]?$/;
const COOKIE_RE = /^[A-Za-z0-9_]{1,64}$/; // 需能組成 nginx 變數 $cookie_<名稱>
const LB_METHODS = ['round_robin', 'least_conn', 'cookie'];
const MAX_UPSTREAMS = 32;

/** 取得規則的後端清單；舊資料沒有清單時以 TargetIp:TargetPort 當唯一一台 */
function upstreamsOf(r) {
  if (Array.isArray(r.Upstreams) && r.Upstreams.length) return r.Upstreams;
  return r.TargetIp ? [{ Host: r.TargetIp, Port: r.TargetPort, Weight: 1, IsBackup: false, IsActive: true }] : [];
}
const activeUpstreams = (r) => upstreamsOf(r).filter((u) => u.IsActive !== false);

const confFileName = (domain) => `${String(domain).toLowerCase().replace(/^\*\./, '_wildcard.')}.conf`;
const certRemotePaths = (certId) => ({
  crt: `${config.ssh.sslDir}/cert_${certId}.crt`,
  key: `${config.ssh.sslDir}/cert_${certId}.key`,
});

/** 回傳錯誤訊息陣列；空陣列 = 通過 */
function validateRule(r) {
  const errs = [];
  if (!r.DomainName || !DOMAIN_RE.test(r.DomainName)) errs.push('來源網域格式不正確（例：portal.aeust.edu.tw）');
  const method = r.LbMethod || 'round_robin';
  if (!LB_METHODS.includes(method)) errs.push('分配方式只能是 輪流 / 最少連線 / 依 Cookie 固定');
  if (method === 'cookie' && !COOKIE_RE.test(String(r.LbCookieName || ''))) errs.push('Cookie 名稱只能用英數字與底線（例：JSESSIONID、PHPSESSID）');
  const all = upstreamsOf(r);
  if (!all.length) errs.push('至少要設定一台後端主機');
  if (all.length > MAX_UPSTREAMS) errs.push(`後端主機最多 ${MAX_UPSTREAMS} 台`);
  const seen = new Set();
  all.forEach((u, i) => {
    const tag = `第 ${i + 1} 台後端`;
    if (!u.Host || !HOST_RE.test(String(u.Host))) errs.push(`${tag} IP/主機名稱格式不正確`);
    const p = Number(u.Port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) errs.push(`${tag} Port 必須為 1–65535`);
    const w = Number(u.Weight ?? 1);
    if (!Number.isInteger(w) || w < 1 || w > 100) errs.push(`${tag} 權重必須為 1–100`);
    const key = `${String(u.Host).toLowerCase()}:${p}`;
    if (seen.has(key)) errs.push(`後端 ${u.Host}:${p} 重複`);
    seen.add(key);
  });
  const active = all.filter((u) => u.IsActive !== false);
  if (all.length && !active.some((u) => !u.IsBackup)) errs.push('至少要有一台「啟用中」且「非備援」的後端主機');
  if (method === 'cookie' && active.some((u) => u.IsBackup)) errs.push('「依 Cookie 固定」不能搭配備援機（nginx hash 不支援 backup）');
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
  const members = activeUpstreams(rule);
  const multi = members.length > 1;
  const upName = rule.Id ? `rule${Number(rule.Id)}_backend` : 'rule_preview_backend';
  const upstream = `http://${upName}`;
  const method = rule.LbMethod || 'round_robin';
  const upstreamBlock = [
    `upstream ${upName} {`,
    ...(method === 'least_conn' ? ['    least_conn;'] : []),
    ...(method === 'cookie' ? [`    hash $cookie_${rule.LbCookieName} consistent;`] : []),
    ...members.map((u) => `    server ${u.Host}:${Number(u.Port)}${Number(u.Weight || 1) > 1 ? ` weight=${Number(u.Weight)}` : ''} max_fails=3 fail_timeout=10s${u.IsBackup ? ' backup' : ''};`),
    '    keepalive 16;',
    '}',
  ];
  const memberText = members.map((u) => `${u.Host}:${u.Port}${u.IsBackup ? '(備援)' : ''}`).join(', ');
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
    ...(multi ? ['    proxy_next_upstream error timeout http_502 http_503 http_504;', '    proxy_next_upstream_tries 3;'] : []),
    `    proxy_connect_timeout ${multi ? '5s' : '10s'};`,
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
  out.push(`# Rule   : #${rule.Id || '-'}  →  ${memberText}${rule.IsMaintenance ? '   [MAINTENANCE MODE]' : ''}`);
  out.push(`# LB     : ${method}${method === 'cookie' ? ` (cookie ${rule.LbCookieName})` : ''}`);
  out.push(`# Remark : ${String(rule.Remark || '').replace(/[\r\n]+/g, ' ')}`);
  out.push('# =====================================================================');
  out.push('');

  if (!rule.IsMaintenance) {
    out.push('# 後端主機（負載平衡）');
    upstreamBlock.forEach((l) => out.push(l));
    out.push('');
  }

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

module.exports = { validateRule, renderConf, confFileName, certRemotePaths, upstreamsOf, LB_METHODS };

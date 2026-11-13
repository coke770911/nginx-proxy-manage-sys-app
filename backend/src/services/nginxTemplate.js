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
const waf = require('./wafService');
const ipAccess = require('./ipAccessService');

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
  errs.push(...waf.validateRuleWaf(r));
  errs.push(...ipAccess.validateRuleIp(r));
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

/**
 * 維護中頁面：原創「戴安全帽的土撥鼠挖地板」SVG 插圖 + CSS 動畫，全部內嵌，不需額外圖檔。
 * 此 HTML 會放進 nginx 的 return 503 '...' 單引號字串，內容不可出現單引號、$（nginx 變數）、反斜線與換行，
 * renderConf() 會再檢查一次。
 */
const MAINT_SVG = [
  '<svg class="art" viewBox="0 0 320 230" role="img" aria-label="戴著安全帽的土撥鼠正在挖地板">',
  // 木地板
  '<rect x="0" y="150" width="320" height="80" fill="#dcaa70"/>',
  '<path d="M0 174H320M0 198H320M0 222H320" stroke="#b9854c" stroke-width="2"/>',
  '<path d="M48 150V174M262 150V174M20 174V198M296 174V198M84 198V222M236 198V222M150 198V222" stroke="#b9854c" stroke-width="2"/>',
  // 洞（後方）
  '<ellipse cx="160" cy="170" rx="74" ry="21" fill="#2b1d14"/>',
  // 三角錐
  '<path d="M276 150l11-38l11 38z" fill="#f07c3e"/><path d="M280 137h14M283 125h8" stroke="#fff" stroke-width="4"/>',
  '<rect x="268" y="148" width="38" height="6" rx="3" fill="#d4622a"/>',
  // 土撥鼠（身體、臉、安全帽）
  '<g class="gh">',
  '<circle cx="125" cy="88" r="11" fill="#7d5434"/><circle cx="195" cy="88" r="11" fill="#7d5434"/>',
  '<circle cx="125" cy="89" r="5" fill="#c99a78"/><circle cx="195" cy="89" r="5" fill="#c99a78"/>',
  '<path d="M106 188C102 124 120 80 160 80C200 80 218 124 214 188Z" fill="#9a6b43"/>',
  '<path d="M132 188C132 146 144 128 160 128C176 128 188 146 188 188Z" fill="#e3c39b"/>',
  '<ellipse cx="160" cy="117" rx="23" ry="17" fill="#ecd5b6"/>',
  '<circle cx="142" cy="101" r="5.5" fill="#2a1d14"/><circle cx="178" cy="101" r="5.5" fill="#2a1d14"/>',
  '<circle cx="144" cy="99" r="1.8" fill="#fff"/><circle cx="180" cy="99" r="1.8" fill="#fff"/>',
  '<ellipse cx="131" cy="115" rx="6.5" ry="3.8" fill="#ec9c8a" opacity=".55"/><ellipse cx="189" cy="115" rx="6.5" ry="3.8" fill="#ec9c8a" opacity=".55"/>',
  '<ellipse cx="160" cy="110" rx="6.5" ry="4.5" fill="#3b2a1e"/>',
  '<path d="M153 117q7 6 14 0" stroke="#3b2a1e" stroke-width="2" fill="none" stroke-linecap="round"/>',
  '<rect x="155.5" y="119" width="9" height="9" rx="2" fill="#fff" stroke="#d8c7b0"/><path d="M160 119v9" stroke="#d8c7b0"/>',
  '<path d="M121 88C121 58 199 58 199 88Z" fill="#f5b82e"/><path d="M160 63v23" stroke="#e09b12" stroke-width="6" stroke-linecap="round"/>',
  '<rect x="112" y="84" width="96" height="10" rx="5" fill="#e09b12"/>',
  '</g>',
  // 洞口土堆與翹起的木板（前方，遮住身體下半）
  '<path d="M84 170Q160 198 236 170Q242 186 228 191Q160 210 92 191Q78 186 84 170Z" fill="#6b4a2f"/>',
  '<path d="M66 160l26-13l6 10l-26 13z" fill="#e6b47c" stroke="#b9854c" stroke-width="2"/>',
  '<path d="M226 152l28 5l-2 11l-28-5z" fill="#e6b47c" stroke="#b9854c" stroke-width="2"/>',
  // 雙手與鏟子
  '<g class="gh">',
  '<path d="M200 166L238 116" stroke="#8a5a2b" stroke-width="5" stroke-linecap="round"/>',
  '<path d="M236 104l14 4l-4 16l-14-4z" fill="#a9bccb" stroke="#7f95a6" stroke-width="2"/>',
  '<circle cx="243" cy="104" r="4" fill="#7a5536"/><circle cx="249" cy="108" r="3" fill="#7a5536"/>',
  '<ellipse cx="121" cy="166" rx="15" ry="9.5" fill="#7d5434"/>',
  '<path d="M111 170v5M117 171v5M123 171v5M129 170v5" stroke="#f3e6d3" stroke-width="2.5" stroke-linecap="round"/>',
  '<ellipse cx="200" cy="166" rx="15" ry="9.5" fill="#7d5434"/>',
  '<path d="M190 170v5M196 171v5M202 171v5M208 170v5" stroke="#f3e6d3" stroke-width="2.5" stroke-linecap="round"/>',
  '</g>',
  // 飛濺的泥土
  '<circle class="dirt l d1" cx="104" cy="150" r="5" fill="#7a5536"/>',
  '<circle class="dirt r d2" cx="218" cy="150" r="4.5" fill="#7a5536"/>',
  '<circle class="dirt l d3" cx="96" cy="140" r="3.5" fill="#8d6441"/>',
  '<circle class="dirt r d4" cx="226" cy="138" r="3.5" fill="#8d6441"/>',
  '<rect class="dirt l d2" x="110" y="146" width="7" height="4" rx="1" fill="#e6b47c"/>',
  '<rect class="dirt r d1" x="206" y="144" width="7" height="4" rx="1" fill="#e6b47c"/>',
  '</svg>',
].join('');

const MAINT_CSS = [
  ':root{color-scheme:light dark}',
  '*{box-sizing:border-box}',
  'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;',
  'font-family:system-ui,-apple-system,"Segoe UI","Microsoft JhengHei","PingFang TC","Noto Sans TC",sans-serif;',
  'background:#f6efe4;color:#3b2a1e}',
  'main{width:100%;max-width:520px;text-align:center;background:#fffaf2;border-radius:20px;padding:28px 24px 32px;',
  'box-shadow:0 10px 30px rgba(107,74,47,.15)}',
  '.art{width:100%;max-width:360px;height:auto;display:block;margin:0 auto 8px}',
  'h1{font-size:1.7rem;margin:8px 0 6px;letter-spacing:.06em}',
  '.sub{margin:0 0 18px;color:#8a6a4f}',
  '.domain{display:inline-block;font-family:ui-monospace,Consolas,monospace;background:#f3e3cc;color:#6b4a2f;',
  'padding:4px 12px;border-radius:999px;font-size:.9rem;margin-bottom:14px;word-break:break-all}',
  'p{line-height:1.7;margin:4px 0}.en{color:#9b8571;font-size:.9rem}',
  '.gh{animation:bob 1.6s ease-in-out infinite}',
  '@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}',
  '.dirt{opacity:0;transform-box:fill-box;transform-origin:center;animation:1.6s ease-out infinite}',
  '.l{animation-name:flyL}.r{animation-name:flyR}',
  '.d2{animation-delay:.4s}.d3{animation-delay:.8s}.d4{animation-delay:1.2s}',
  '@keyframes flyL{0%{opacity:0;transform:translate(14px,14px) scale(.5)}25%{opacity:1}100%{opacity:0;transform:translate(-26px,-34px) scale(1)}}',
  '@keyframes flyR{0%{opacity:0;transform:translate(-14px,14px) scale(.5)}25%{opacity:1}100%{opacity:0;transform:translate(26px,-34px) scale(1)}}',
  '@media (prefers-reduced-motion:reduce){.gh,.dirt{animation:none}.dirt{opacity:1}}',
  '@media (prefers-color-scheme:dark){body{background:#1f1813;color:#f1e4d3}main{background:#2a211a;box-shadow:none}',
  '.sub{color:#cdb398}.domain{background:#3a2d22;color:#f1d7b5}.en{color:#a8927c}}',
].join('');

const maintenanceHtml = (domain) => [
  '<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">',
  `<title>系統維護中 - ${domain}</title><style>${MAINT_CSS}</style></head><body><main>`,
  MAINT_SVG,
  '<h1>系統維護中</h1>',
  '<p class="sub">土撥鼠工程隊正在努力施工，馬上就好！</p>',
  `<div class="domain">${domain}</div>`,
  '<p>目前進行系統維護作業，造成不便敬請見諒，請稍後再試。</p>',
  '<p class="en">This site is under maintenance. Please try again later.</p>',
  '</main></body></html>',
].join('');

/* ------------------------------------------------------------------ 柴犬錯誤頁（404 預設站台、後端連不上） */
// 原創 SVG：柴犬拿著放大鏡，放大鏡當作三位數狀態碼中間的數字（例：4 [放大鏡] 4、5 [放大鏡] 2）
const shibaSvg = (left, right, label) => [
  `<svg class="art" viewBox="0 0 360 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${label}">`,
  '<ellipse cx="180" cy="224" rx="130" ry="10" fill="#ead9c2"/>',
  `<text x="78" y="128" font-size="112" font-weight="800" fill="#f0b34e" text-anchor="middle" font-family="Arial,sans-serif">${left}</text>`,
  `<text x="282" y="128" font-size="112" font-weight="800" fill="#f0b34e" text-anchor="middle" font-family="Arial,sans-serif">${right}</text>`,
  '<g class="lens">',
  '<line x1="207" y1="98" x2="230" y2="128" stroke="#6b4a2f" stroke-width="12" stroke-linecap="round"/>',
  '<circle cx="180" cy="70" r="38" fill="#e3f3fb" stroke="#6b4a2f" stroke-width="9"/>',
  '<path d="M160 56A24 24 0 0 1 178 46" stroke="#fff" stroke-width="6" fill="none" stroke-linecap="round"/>',
  '</g>',
  '<g class="dog">',
  '<ellipse cx="180" cy="206" rx="42" ry="22" fill="#e39a52"/>',
  '<ellipse cx="180" cy="210" rx="22" ry="14" fill="#fff1dc"/>',
  '<path d="M206 196C222 176 228 150 230 132" stroke="#e39a52" stroke-width="14" fill="none" stroke-linecap="round"/>',
  '<circle cx="230" cy="130" r="9" fill="#fff1dc"/>',
  '<path d="M150 146L148 112L172 132Z" fill="#e39a52"/><path d="M210 146L212 112L188 132Z" fill="#e39a52"/>',
  '<path d="M154 140L153 120L166 132Z" fill="#f7c9a8"/><path d="M206 140L207 120L194 132Z" fill="#f7c9a8"/>',
  '<circle cx="180" cy="160" r="33" fill="#e39a52"/>',
  '<path d="M152 168C156 186 168 193 180 193C192 193 204 186 208 168C200 174 190 172 180 172C170 172 160 174 152 168Z" fill="#fff1dc"/>',
  '<ellipse cx="168" cy="158" rx="4.5" ry="5" fill="#3b2a1e"/><ellipse cx="192" cy="158" rx="4.5" ry="5" fill="#3b2a1e"/>',
  '<circle cx="169.5" cy="156" r="1.6" fill="#fff"/><circle cx="193.5" cy="156" r="1.6" fill="#fff"/>',
  '<path d="M162 150L171 146M198 150L189 146" stroke="#8a5a32" stroke-width="2.5" stroke-linecap="round"/>',
  '<ellipse cx="180" cy="171" rx="5" ry="3.6" fill="#3b2a1e"/>',
  '<path d="M174 179Q180 175 186 179" stroke="#3b2a1e" stroke-width="2" fill="none" stroke-linecap="round"/>',
  '<circle cx="158" cy="174" r="5" fill="#f59a9a" opacity=".55"/><circle cx="202" cy="174" r="5" fill="#f59a9a" opacity=".55"/>',
  '</g>',
  '<text class="q q1" x="120" y="150" font-size="26" font-weight="700" fill="#b08a68" font-family="Arial,sans-serif">?</text>',
  '<text class="q q2" x="106" y="186" font-size="18" font-weight="700" fill="#c9ab8e" font-family="Arial,sans-serif">?</text>',
  '</svg>',
].join('');

const NOTFOUND_CSS = MAINT_CSS + [
  '.lens{transform-box:fill-box;transform-origin:70% 90%;animation:sweep 2.6s ease-in-out infinite}',
  '@keyframes sweep{0%,100%{transform:rotate(-6deg)}50%{transform:rotate(6deg)}}',
  '.dog{transform-box:fill-box;transform-origin:50% 100%;animation:tilt 2.6s ease-in-out infinite}',
  '@keyframes tilt{0%,100%{transform:rotate(-2deg)}50%{transform:rotate(2deg)}}',
  '.q{animation:bob 1.8s ease-in-out infinite}.q2{animation-delay:.6s}',
  '.code{font-family:ui-monospace,Consolas,monospace;color:#c98a2e;font-weight:700;letter-spacing:.08em}',
  '@media (prefers-reduced-motion:reduce){.lens,.dog,.q{animation:none}}',
].join('');

/** 柴犬錯誤頁共用外框；所有文字皆為程式內固定字串或已驗證的網域 */
const shibaPage = ({ code, title, sub, codeText, msg, en, domain }) => [
  '<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">',
  `<title>${code} ${title}${domain ? ` - ${domain}` : ''}</title><style>${NOTFOUND_CSS}</style></head><body><main>`,
  shibaSvg(code[0], code[2], `柴犬拿著放大鏡：${title}`),
  `<h1>${title}</h1>`,
  `<p class="sub">${sub}</p>`,
  ...(domain ? [`<div class="domain">${domain}</div>`] : []),
  `<div class="code">${codeText}</div>`,
  `<p>${msg}</p>`,
  `<p class="en">${en}</p>`,
  '</main></body></html>',
].join('');

/** 404：直接以 IP 或未設定的網域連線（預設站台） */
const notFoundHtml = () => shibaPage({
  code: '404', title: '找不到這個網頁',
  sub: '柴犬拿著放大鏡找遍了每個角落，還是沒找到…',
  codeText: 'HTTP 404 · Page Not Found',
  msg: '請確認網址是否正確，或使用正式網域名稱連線。',
  en: 'The page you requested was not found on this server.',
});

/** 502 / 504：Nginx 連不上後端（後端沒開、Port 沒在監聽、防火牆擋住或逾時） */
const backendDownHtml = (domain, code) => shibaPage({
  code, domain, title: '暫時找不到服務',
  sub: '柴犬拿著放大鏡找了半天，後端伺服器沒有回應…',
  codeText: code === '504' ? 'HTTP 504 · Gateway Timeout' : 'HTTP 502 · Bad Gateway',
  msg: '網站服務暫時無法連線，請稍後再試；若持續發生，請聯絡網站管理者。',
  en: 'The service is temporarily unavailable. Please try again later.',
});

/** 403：來源 IP 被 IP 存取控制拒絕；IP_MARK 會在 returnHtml 換成 $remote_addr（真實來源 IP） */
const IP_MARK = '@@CLIENT_IP@@';
const ipDeniedHtml = (domain) => shibaPage({
  code: '403', domain, title: '無法存取這個網站',
  sub: '柴犬拿著放大鏡核對了來源位址，這個位址目前沒有存取權限…',
  codeText: `HTTP 403 · 您的 IP：${IP_MARK}`,
  msg: '您目前的網路位置無法存取此網站；若您認為這是錯誤，請將上方 IP 提供給網站管理者。',
  en: 'Access to this site is not allowed from your network address.',
});

/**
 * 產生回傳整頁 HTML 的 nginx 指令。
 * nginx 單一參數上限 4096 bytes（超過會出現 "too long parameter"），頁面約 5 KB，
 * 所以切成每段 ≤ 3000 bytes 存進變數，再以 return <code> "$p0$p1..." 組合；變數內容不會再被 nginx 解析。
 * 同一請求只會進入一個 location，不同 location 共用變數名稱不會互相影響。
 */
const PAGE_CHUNK_BYTES = 3000;
function chunkText(safe) {
  const chunks = [];
  let cur = '';
  for (const ch of safe) { // 以字元為單位切，不會切斷 UTF-8 中文字
    if (Buffer.byteLength(cur + ch) > PAGE_CHUNK_BYTES) { chunks.push(cur); cur = ''; }
    cur += ch;
  }
  if (cur) chunks.push(cur);
  return chunks;
}
function returnHtml(code, html) {
  // HTML 中的 IP_MARK 換成 nginx 變數 $remote_addr（只會是 IP 字元）；其餘內容維持單引號字串、不被 nginx 解析
  const parts = html.split(IP_MARK).map((p) => chunkText(safeNginxString(p)));
  if (parts.length === 1 && parts[0].length === 1) return [`return ${code} '${parts[0][0]}';`];
  const sets = [];
  const refs = [];
  let n = 0;
  parts.forEach((chunks, pi) => {
    if (pi > 0) refs.push('$remote_addr');
    chunks.forEach((c) => { sets.push(`set $page_part${n} '${c}';`); refs.push(`$page_part${n}`); n += 1; });
  });
  return [...sets, `return ${code} "${refs.join('')}";`];
}

/** 放進 nginx 單引號字串前的最後防線：不可含 ' $ \ 或換行 */
function safeNginxString(s) {
  if (/['$\\\r\n]/.test(s)) throw new Error('維護頁面 HTML 含有 nginx 字串不允許的字元（單引號、$、反斜線或換行）');
  return s;
}

/**
 * PROXY protocol（.env PROXY_PROTOCOL_FROM 有值才啟用）：
 * 另外監聽 httpPort / httpsPort 並帶 proxy_protocol，F5 pool 指到這兩個 port；原本 80 / 443 不變（直連與 F5 健康檢查照舊）。
 * real_ip 只信任 PROXY_PROTOCOL_FROM（config 已驗證為 IPv4 / CIDR），$remote_addr 會還原成真實客戶端 IP，
 * 送給後端的 X-Real-IP / X-Forwarded-For 與 access log 都隨之正確。沒帶 PROXY 標頭的連線不受影響。
 */
const pp = () => config.nginx.proxyProtocol;
function ppHttpListen(defaultServer = false) {
  if (!pp().enabled) return [];
  return [`    listen ${pp().httpPort}${defaultServer ? ' default_server' : ''} proxy_protocol;`];
}
function ppHttpsListen(defaultServer = false) {
  if (!pp().enabled) return [];
  const ds = defaultServer ? ' default_server' : '';
  return [config.nginx.http2Syntax === 'legacy'
    ? `    listen ${pp().httpsPort} ssl http2${ds} proxy_protocol;`
    : `    listen ${pp().httpsPort} ssl${ds} proxy_protocol;`];
}
function ppRealIp() {
  if (!pp().enabled) return [];
  return [
    ...pp().from.map((ip) => `    set_real_ip_from ${ip};`),
    '    real_ip_header proxy_protocol;',
    '    port_in_redirect off;',
  ];
}

/**
 * @param {object} rule
 * @param {{ waf?: object, ipBlock?: boolean }} [opts]
 *   waf = WAF 全域設定（WafSettings）；未提供或總開關關閉時不產生 WAF 指令
 *   ipBlock = 本次部署是否有全域 IP 黑名單（_ip_blocklist.conf 定義 $npm_ip_blocked）
 */
function renderConf(rule, opts = {}) {
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
  const wafLines = waf.serverWafLines(rule, opts.waf);
  const wafOn = wafLines.length > 0;
  const ipLines = ipAccess.serverIpLines(rule, !!opts.ipBlock);
  const ipOn = ipLines.length > 0;
  const ipAcl = ipAccess.ruleAcl(rule);
  // IP 被拒絕時 rewrite 到這個 internal location，回 403 頁面（不經過 WAF、不送後端）
  const ipDeniedLocation = [
    `location = ${ipAccess.DENIED_URI} {`,
    '    internal;',
    ...(wafOn ? ['    modsecurity off;'] : []),
    '    default_type text/html;',
    '    charset utf-8;',
    '    add_header Cache-Control "no-store" always;',
    ...returnHtml('403', ipDeniedHtml(domain)).map((l) => `    ${l}`),
    '}',
  ].join('\n');

  const healthLocation = [
    'location = /f5-health-check {',
    '    access_log off;',
    ...(wafOn ? ['    modsecurity off;'] : []),
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
    // 只攔 Nginx 自己產生的 502 / 504（連不上後端或逾時）；後端自己回的錯誤頁不攔（未開 proxy_intercept_errors）
    '    error_page 502 @backend_502;',
    '    error_page 504 @backend_504;',
    '}',
    '',
    ...['502', '504'].flatMap((code) => [
      `location @backend_${code} {`,
      '    default_type text/html;',
      '    charset utf-8;',
      '    add_header Cache-Control "no-store" always;',
      ...returnHtml(code, backendDownHtml(domain, code)).map((l) => `    ${l}`),
      '}',
    ]),
  ].join('\n');

  const maintenanceLocation = [
    'location / {',
    '    default_type text/html;',
    '    charset utf-8;',
    '    add_header Retry-After 3600 always;',
    '    add_header Cache-Control "no-store" always;',
    ...returnHtml('503', maintenanceHtml(domain)).map((l) => `    ${l}`),
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
  if (wafOn) out.push(`# WAF    : ${waf.WAF_MODE_LABEL[rule.WafMode]}`);
  if (ipOn) out.push(`# IP ACL : ${[opts.ipBlock && '全域黑名單', ipAcl && `${ipAccess.MODE_LABEL[ipAcl.mode]} ${ipAcl.entries.length} 筆`].filter(Boolean).join(' + ')}`);
  out.push(`# Remark :${String(rule.Remark || '').replace(/[\r\n]+/g, ' ')}`);
  out.push('# =====================================================================');
  out.push('');

  if (!rule.IsMaintenance) {
    out.push('# 後端主機（負載平衡）');
    upstreamBlock.forEach((l) => out.push(l));
    out.push('');
  }

  ipAccess.ruleGeoLines(rule).forEach((l) => out.push(l));

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
  ppHttpListen().forEach((l) => out.push(l));
  out.push(`    server_name ${domain};`);
  ppRealIp().forEach((l) => out.push(l));
  if (ipOn) { out.push(''); ipLines.forEach((l) => out.push(l)); }
  out.push('');
  out.push(indent(healthLocation));
  out.push('');
  if (ipOn) { out.push(indent(ipDeniedLocation)); out.push(''); }
  if (rule.ForceHttps) {
    out.push('    location / {');
    out.push('        return 301 https://$host$request_uri;');
    out.push('    }');
  } else {
    out.push(indent(bodySize));
    wafLines.forEach((l) => out.push(l));
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
  ppHttpsListen().forEach((l) => out.push(l));
  out.push(`    server_name ${domain};`);
  ppRealIp().forEach((l) => out.push(l));
  if (ipOn) { out.push(''); ipLines.forEach((l) => out.push(l)); }
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
  wafLines.forEach((l) => out.push(l));
  out.push('');
  out.push(indent(healthLocation));
  out.push('');
  if (ipOn) { out.push(indent(ipDeniedLocation)); out.push(''); }
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

/**
 * 預設站台（default_server）：以 IP 或未設定的網域連線時回 404 可愛頁面，
 * 避免落到第一個網域規則而被轉給不相干的後端。/f5-health-check 仍回 200，F5 以 IP 探測不受影響。
 * 檔名以底線開頭，網域規則（需符合 DOMAIN_RE）不可能產生相同檔名。
 * @param {number|null} certId 443 用的憑證（沒有任何規則時為 null，只建立 80）
 */
const DEFAULT_CONF_NAME = '_default_server.conf';
function renderDefaultConf(certId) {
  const page = [
    '    location = /f5-health-check {',
    '        access_log off;',
    '        default_type text/plain;',
    '        return 200 "OK\\n";',
    '    }',
    '',
    '    location / {',
    '        default_type text/html;',
    '        charset utf-8;',
    '        add_header Cache-Control "no-store" always;',
    '        add_header X-NPM-Default "1" always;  # 切換前檢查用：辨識「沒有對應規則」',
    ...returnHtml('404', notFoundHtml()).map((l) => `        ${l}`),
    '    }',
  ];
  const out = [
    '# =====================================================================',
    '# Managed by Nginx HA Proxy Manager — 請勿手動修改，下次部署會被覆寫',
    '# 預設站台：直接以 IP 或未設定的網域連線時回 404 頁面',
    '# =====================================================================',
    '',
    'server {',
    '    listen 80 default_server;',
    ...ppHttpListen(true),
    '    server_name _;',
    ...ppRealIp(),
    '',
    ...page,
    '}',
  ];
  if (certId) {
    const { crt, key } = certRemotePaths(Number(certId));
    out.push('');
    out.push('server {');
    if (config.nginx.http2Syntax === 'legacy') {
      out.push('    listen 443 ssl http2 default_server;');
    } else {
      out.push('    listen 443 ssl default_server;');
      out.push('    http2 on;');
    }
    ppHttpsListen(true).forEach((l) => out.push(l));
    out.push('    server_name _;');
    ppRealIp().forEach((l) => out.push(l));
    out.push('');
    out.push(`    ssl_certificate     ${crt};`);
    out.push(`    ssl_certificate_key ${key};`);
    out.push('    ssl_protocols TLSv1.2 TLSv1.3;');
    out.push('    ssl_prefer_server_ciphers off;');
    out.push('    ssl_session_cache shared:SSL:10m;');
    out.push('    ssl_session_timeout 1d;');
    out.push('    ssl_session_tickets off;');
    out.push('');
    page.forEach((l) => out.push(l));
    out.push('}');
  }
  out.push('');
  return out.join('\n');
}

module.exports = { validateRule, renderConf, renderDefaultConf, DEFAULT_CONF_NAME, confFileName, certRemotePaths, upstreamsOf, LB_METHODS };

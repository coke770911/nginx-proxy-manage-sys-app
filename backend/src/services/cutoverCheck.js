'use strict';
/**
 * 切換前檢查（DNS 改指 F5 VIP 之前的模擬測試，唯讀）
 *
 * 從管理主機直接發出 HTTP(S) GET，不經 SSH：
 *  1. DNS 現況：網域目前解析到哪裡（直接查 DNS 伺服器，不吃本機快取）
 *  2. 經 VIP（.env CUTOVER_VIP）以正確 SNI / Host 請求多次，讓每台後端都輪到
 *  3. 轉址迴圈、http → https 轉址、憑證是否涵蓋網域
 *  4. 與現行路徑（目前 DNS 指向的位址）比對狀態碼與頁面大小
 *  5. 直接連每台啟用中的 Nginx 節點，找出「尚未部署」或「節點連不到後端」
 *
 * 安全：只發 GET、路徑固定為 "/"（只跟隨同網域的轉址），連線對象只有
 * 規則中的網域、.env 的 VIP、已登錄的節點與網域本身的 DNS 解析結果，不接受使用者輸入的位址。
 */
const http = require('http');
const https = require('https');
const tls = require('tls');
const dns = require('dns').promises;
const config = require('../config');
const { upstreamsOf } = require('./nginxTemplate');

const TIMEOUT_MS = 10000;
const MAX_BODY = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_REPEAT = 10;
const DOMAIN_CONCURRENCY = 5;
const SIZE_DIFF_RATIO = 0.1;
const DEFAULT_SITE_HEADER = 'x-npm-default';
const DEFAULT_SITE_MARKER = 'HTTP 404 · Page Not Found'; // 預設站台 404 頁的固定文字（nginxTemplate notFoundHtml）

/** 對指定 IP 發一次 GET（帶 SNI 與 Host），回傳狀態碼、Location、大小、耗時與憑證檢查結果 */
function requestVia(ip, { scheme, domain, path = '/' }) {
  const mod = scheme === 'https' ? https : http;
  const started = Date.now();
  return new Promise((resolve) => {
    const opts = {
      host: ip,
      port: scheme === 'https' ? 443 : 80,
      path,
      method: 'GET',
      agent: false,
      headers: { Host: domain, 'User-Agent': 'NginxHAProxyManager-CutoverCheck', Accept: '*/*', Connection: 'close' },
      timeout: TIMEOUT_MS,
    };
    if (scheme === 'https') Object.assign(opts, { servername: domain, rejectUnauthorized: false });
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve({ ms: Date.now() - started, ...r }); } };
    const req = mod.request(opts, (res) => {
      let cert = null;
      if (scheme === 'https') {
        const sock = res.socket;
        const peer = sock.getPeerCertificate ? sock.getPeerCertificate() : null;
        const idErr = peer && peer.subject ? tls.checkServerIdentity(domain, peer) : new Error('沒有取得憑證');
        cert = {
          trusted: !!sock.authorized,
          trustError: sock.authorized ? null : String(sock.authorizationError || ''),
          matches: !idErr,
          subject: peer?.subject?.CN || '',
          validTo: peer?.valid_to || '',
        };
      }
      let size = 0;
      let head = ''; // 只留前 8KB 文字，用來辨識舊版（尚無識別標頭）的 404 預設頁
      res.on('data', (c) => {
        size += c.length;
        if (head.length < 8192) head += c.toString('utf8', 0, Math.min(c.length, 8192));
        if (size > MAX_BODY) req.destroy();
      });
      const end = () => finish({
        status: res.statusCode,
        location: res.headers.location || null,
        size,
        defaultSite: res.headers[DEFAULT_SITE_HEADER] === '1'
          || (res.statusCode === 404 && head.includes(DEFAULT_SITE_MARKER)),
        server: res.headers.server || '',
        cert,
      });
      res.on('end', end);
      res.on('close', end);
    });
    req.on('timeout', () => { req.destroy(new Error(`逾時（${TIMEOUT_MS / 1000} 秒）`)); });
    req.on('error', (e) => finish({ status: 0, error: e.code === 'ECONNREFUSED' ? '拒絕連線' : e.message }));
    req.end();
  });
}

/** 解析 Location 為絕對網址；同網域才回傳 { scheme, path } */
function sameHostTarget(location, domain, scheme) {
  try {
    const u = new URL(location, `${scheme}://${domain}/`);
    if (u.hostname.toLowerCase() !== domain) return { external: u.href };
    return { scheme: u.protocol.replace(':', ''), path: `${u.pathname}${u.search}`, href: u.href };
  } catch { return { external: String(location) }; }
}

/** 從 VIP 跟隨同網域轉址，偵測迴圈；回傳最終結果與轉址鏈 */
async function followVia(ip, domain, scheme) {
  const chain = [];
  const seen = new Set();
  let cur = { scheme, path: '/', href: `${scheme}://${domain}/` };
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (seen.has(cur.href)) return { loop: true, chain, final: chain[chain.length - 1] };
    seen.add(cur.href);
    const r = await requestVia(ip, { scheme: cur.scheme, domain, path: cur.path });
    chain.push({ url: cur.href, ...r });
    if (!(r.status >= 300 && r.status < 400 && r.location)) return { loop: false, chain, final: r };
    const next = sameHostTarget(r.location, domain, cur.scheme);
    if (next.external) return { loop: false, chain, final: r, external: next.external };
    cur = next;
  }
  return { loop: true, chain, final: chain[chain.length - 1] };
}

/** 查目前 DNS（直接問 DNS 伺服器）：{ cname, ips, error } */
async function resolveNow(domain) {
  const out = { cname: null, ips: [], error: null };
  try { out.cname = (await dns.resolveCname(domain))[0] || null; } catch { /* 不是 CNAME */ }
  try { out.ips = await dns.resolve4(domain); } catch (e) { out.error = e.code === 'ENOTFOUND' || e.code === 'ENODATA' ? '查無 A 紀錄' : e.message; }
  return out;
}

const isOk = (s) => s >= 200 && s < 400;

/** 檢查一個網域 */
async function checkDomain(rule, domain, nodes) {
  const vip = config.cutover.vip;
  const issues = []; // { level: 'fail' | 'warn' | 'info', text }
  const add = (level, text) => issues.push({ level, text });

  const activeUps = upstreamsOf(rule).filter((u) => u.IsActive !== false);
  const repeat = Math.min(MAX_REPEAT, Math.max(2, activeUps.length * 2));

  // 1. DNS 現況
  const dnsNow = await resolveNow(domain);
  const switched = dnsNow.ips.length > 0 && dnsNow.ips.every((ip) => ip === vip);
  if (dnsNow.error) add('info', `DNS 目前${dnsNow.error}，無法比對現行路徑`);

  // 2. 經 VIP 走 https，重複請求
  const vipHttps = [];
  for (let i = 0; i < repeat; i += 1) vipHttps.push(await requestVia(vip, { scheme: 'https', domain }));
  const errs = vipHttps.filter((r) => r.status === 0);
  const statuses = [...new Set(vipHttps.map((r) => r.status))];
  if (errs.length) add('fail', `經 VIP 有 ${errs.length} / ${repeat} 次連線失敗：${errs[0].error}`);
  if (vipHttps.some((r) => r.defaultSite)) add('fail', '落到 404 預設頁：Nginx 沒有這個網域的規則，或規則尚未部署');
  const bad5xx = vipHttps.filter((r) => r.status >= 500);
  if (bad5xx.length) {
    const codes = [...new Set(bad5xx.map((r) => r.status))].join(' / ');
    add('fail', `有 ${bad5xx.length} / ${repeat} 次回應 ${codes}${codes.includes('503') && rule.IsMaintenance ? '（規則設為維護中）' : '（後端連不上或錯誤）'}`);
  }
  const bad4xx = vipHttps.filter((r) => r.status >= 400 && r.status < 500 && !r.defaultSite);
  if (bad4xx.length) add('warn', `有 ${bad4xx.length} / ${repeat} 次回應 ${[...new Set(bad4xx.map((r) => r.status))].join(' / ')}`);
  if (statuses.filter((s) => s > 0).length > 1) add('warn', `各次回應不一致（${statuses.join(' / ')}），可能某台後端設定不同`);

  // 3. 轉址迴圈與憑證
  const httpsFollow = await followVia(vip, domain, 'https');
  if (httpsFollow.loop) add('fail', '轉址迴圈：後端可能自己強制 HTTPS，請改依 X-Forwarded-Proto 判斷');
  // 有的請求可能輪到別台後端才出現迴圈：任何一次 3xx 指回同一網址就算
  if (!httpsFollow.loop && vipHttps.some((r) => r.status >= 300 && r.status < 400 && r.location
      && sameHostTarget(r.location, domain, 'https').href === `https://${domain}/`)) {
    add('fail', '部分請求轉址回同一網址（轉址迴圈），某台後端可能強制 HTTPS');
  }
  if (httpsFollow.external) add('info', `轉址到其他網域：${httpsFollow.external}`);
  const cert = vipHttps.find((r) => r.cert)?.cert || null;
  if (cert && !cert.matches) add('fail', `憑證不涵蓋 ${domain}（憑證 CN：${cert.subject || '—'}）`);
  else if (cert && !cert.trusted) add('warn', `憑證鏈無法驗證：${cert.trustError}`);

  // 4. 經 VIP 走 http
  const vipHttp = await requestVia(vip, { scheme: 'http', domain });
  if (rule.ForceHttps) {
    const t = vipHttp.location ? sameHostTarget(vipHttp.location, domain, 'http') : {};
    if (!(vipHttp.status === 301 || vipHttp.status === 308) || t.scheme !== 'https') {
      add('warn', `http 未轉到 https（回應 ${vipHttp.status || vipHttp.error}）`);
    }
  }

  // 5. 與現行路徑比對（DNS 已指向 VIP 時略過）
  let current = null;
  if (!switched && dnsNow.ips.length && !httpsFollow.loop) {
    const ip = dnsNow.ips[0];
    let r = await requestVia(ip, { scheme: 'https', domain });
    let scheme = 'https';
    if (r.status === 0) { r = await requestVia(ip, { scheme: 'http', domain }); scheme = 'http'; }
    let finalR = r;
    if (r.status >= 300 && r.status < 400) finalR = (await followVia(ip, domain, scheme)).final || r;
    const newFinal = httpsFollow.final || {};
    current = { ip, scheme, status: r.status, finalStatus: finalR.status, size: finalR.size, error: r.error || null };
    if (r.status === 0) add('info', `現行路徑 ${ip} 連不上（${r.error}），無法比對`);
    else if (isOk(finalR.status) && isOk(newFinal.status)) {
      const base = Math.max(finalR.size, 1);
      if (Math.abs(finalR.size - newFinal.size) / base > SIZE_DIFF_RATIO) {
        add('warn', `頁面大小與現行不同（現行 ${finalR.size} bytes，經 VIP ${newFinal.size} bytes）`);
      }
    } else if (isOk(finalR.status) !== isOk(newFinal.status)) {
      add('warn', `狀態與現行不同（現行 ${finalR.status}，經 VIP ${newFinal.status || '失敗'}）`);
    }
  }

  // 6. 各節點直連
  const nodeResults = [];
  for (const n of nodes) {
    const r = await requestVia(n.IpAddress, { scheme: 'https', domain });
    nodeResults.push({ node: n.NodeName, ip: n.IpAddress, status: r.status, error: r.error || null, defaultSite: r.defaultSite, ms: r.ms });
    if (r.status === 0) add('warn', `節點 ${n.NodeName} 連不上：${r.error}`);
    else if (r.defaultSite) add('fail', `節點 ${n.NodeName} 沒有這個網域的規則（尚未部署？）`);
    else if (r.status === 502 || r.status === 504) add('fail', `節點 ${n.NodeName} 連不到後端（${r.status}）`);
  }

  const verdict = issues.some((i) => i.level === 'fail') ? 'fail' : issues.some((i) => i.level === 'warn') ? 'warn' : 'pass';
  return {
    domain,
    verdict,
    issues,
    dns: { ...dnsNow, switched },
    vip: {
      https: vipHttps.map((r) => ({ status: r.status, size: r.size, ms: r.ms, location: r.location, error: r.error || null })),
      follow: httpsFollow.chain.map((c) => ({ url: c.url, status: c.status, location: c.location, size: c.size })),
      http: { status: vipHttp.status, location: vipHttp.location, error: vipHttp.error || null },
      cert,
    },
    current,
    nodes: nodeResults,
  };
}

/** 依併發上限執行 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i; i += 1;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * @param {object[]} rules 含 Upstreams 的規則（plain object）
 * @param {object[]} nodes 啟用中的節點
 */
async function checkRules(rules, nodes) {
  const jobs = [];
  for (const rule of rules) {
    if (String(rule.DomainName).startsWith('*.')) {
      jobs.push({ rule, skip: '萬用網域無法直接檢查，請改用實際的子網域' });
    } else if (!rule.IsActive) {
      jobs.push({ rule, skip: '規則未啟用，不會部署到節點' });
    } else {
      jobs.push({ rule, domain: String(rule.DomainName).toLowerCase() });
    }
  }
  const results = await mapLimit(jobs, DOMAIN_CONCURRENCY, async (j) => {
    if (j.skip) return { ruleId: j.rule.Id, domain: j.rule.DomainName, verdict: 'skip', issues: [{ level: 'info', text: j.skip }] };
    try {
      return { ruleId: j.rule.Id, ...(await checkDomain(j.rule, j.domain, nodes)) };
    } catch (e) {
      return { ruleId: j.rule.Id, domain: j.domain, verdict: 'fail', issues: [{ level: 'fail', text: `檢查失敗：${e.message}` }] };
    }
  });
  return { vip: config.cutover.vip, checkedAt: new Date().toISOString(), results };
}

module.exports = { checkRules, DEFAULT_SITE_HEADER, MAX_BATCH: 50 };

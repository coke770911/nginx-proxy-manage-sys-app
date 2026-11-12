'use strict';
/**
 * 網域對照規則 CSV 匯入 / 匯出
 *
 * 欄位（第一列為標題，可用中文或英文欄位名，順序不限）：
 *   來源網域 DomainName（必填）
 *   後端主機 Backends（必填）多台以 ; 或換行分隔，每台格式：
 *       10.0.0.21:8080          一般
 *       10.0.0.22:8080*3        權重 3
 *       10.0.0.23:8080(備援)    備援機，也可寫 (backup)
 *       10.0.0.24:8080(停用)    暫時停用，也可寫 (off)
 *   分配方式 LbMethod   輪流 / 最少連線 / 依Cookie固定（或 round_robin / least_conn / cookie），空白 = 輪流
 *   Cookie名稱 LbCookieName
 *   SSL憑證 Certificate  憑證別名或編號；空白 = 自動選涵蓋此網域、到期日最晚的憑證
 *   強制HTTPS ForceHttps / WebSocket EnableWebSocket / 啟用 IsActive / 維護中 IsMaintenance：是/否、Y/N、1/0、true/false
 *   上傳上限 ClientMaxBodySize / 備註 Remark
 * 空白欄位：新增時用預設值，覆蓋既有規則時保留原值。自訂 Nginx 語法不在匯入範圍內（保留原值）。
 */
const { validateRule } = require('./nginxTemplate');
const { certCoversDomain } = require('./certService');

const MAX_ROWS = 500;
const DOMAIN_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i; // 與 nginxTemplate 相同

const COLUMNS = [
  { key: 'DomainName', title: '來源網域', alias: ['domain', '網域'] },
  { key: 'Backends', title: '後端主機', alias: ['backend', 'upstreams', '後端', '後端目標'] },
  { key: 'LbMethod', title: '分配方式', alias: ['lb', 'method'] },
  { key: 'LbCookieName', title: 'Cookie名稱', alias: ['cookie', 'cookie 名稱'] },
  { key: 'Certificate', title: 'SSL憑證', alias: ['cert', 'certificate', 'ssl 憑證', '憑證'] },
  { key: 'ForceHttps', title: '強制HTTPS', alias: ['https', '強制 https'] },
  { key: 'EnableWebSocket', title: 'WebSocket', alias: ['websocket', 'ws'] },
  { key: 'ClientMaxBodySize', title: '上傳上限', alias: ['bodysize', '上傳檔案上限'] },
  { key: 'IsActive', title: '啟用', alias: ['active', 'enabled'] },
  { key: 'IsMaintenance', title: '維護中', alias: ['maintenance', '維護中頁面'] },
  { key: 'Remark', title: '備註', alias: ['remark', 'note'] },
];
const BOOL_KEYS = ['ForceHttps', 'EnableWebSocket', 'IsActive', 'IsMaintenance'];
const LB_NAMES = {
  round_robin: 'round_robin', 輪流: 'round_robin', rr: 'round_robin',
  least_conn: 'least_conn', 最少連線: 'least_conn', leastconn: 'least_conn',
  cookie: 'cookie', 依cookie固定: 'cookie', 'cookie固定': 'cookie', 依cookie: 'cookie',
};
const LB_TEXT = { round_robin: '輪流', least_conn: '最少連線', cookie: '依Cookie固定' };

const norm = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();

/** RFC 4180 CSV 解析（支援引號、引號內逗號與換行、"" 跳脫；自動判斷逗號或 Tab 分隔） */
function parseCsv(text) {
  const src = String(text).replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const sep = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? '\t' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (q) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 1; } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function parseBool(v, errs, title) {
  const s = norm(v);
  if (!s) return null;
  if (['是', 'y', 'yes', '1', 'true', 'v', '開', 'on'].includes(s)) return true;
  if (['否', 'n', 'no', '0', 'false', 'x', '關', 'off'].includes(s)) return false;
  errs.push(`「${title}」只能填 是 / 否（目前：${v}）`);
  return null;
}

/** 解析後端主機欄位 → [{ Host, Port, Weight, IsBackup, IsActive }] */
function parseBackends(text, errs) {
  const items = String(text || '').split(/[;\n；、]+/).map((s) => s.trim()).filter(Boolean);
  if (!items.length) { errs.push('「後端主機」必填（例：10.0.0.21:8080）'); return []; }
  return items.map((it, i) => {
    const m = it.match(/^([A-Za-z0-9.-]+):(\d{1,5})(?:\s*\*\s*(\d{1,3}))?\s*((?:[(（][^)）]*[)）]\s*)*)$/);
    if (!m) { errs.push(`第 ${i + 1} 台後端「${it}」格式不正確（例：10.0.0.21:8080、10.0.0.22:8080*3、10.0.0.23:8080(備援)）`); return null; }
    const flags = norm(m[4]);
    const unknown = flags.replace(/[(（](備援|backup|停用|off|disabled)[)）]/g, '');
    if (unknown) errs.push(`第 ${i + 1} 台後端「${it}」的標記只能是 (備援) 或 (停用)`);
    return {
      Host: m[1],
      Port: Number(m[2]),
      Weight: m[3] ? Number(m[3]) : 1,
      IsBackup: /備援|backup/.test(flags),
      IsActive: !/停用|off|disabled/.test(flags),
    };
  }).filter(Boolean);
}

/** CSV 文字 → 列物件（尚未比對資料庫） */
function rowsFromCsv(text) {
  const table = parseCsv(text).filter((r) => r.some((c) => String(c).trim() !== ''));
  if (!table.length) throw new Error('檔案是空的');
  const header = table[0].map(norm);
  const idx = {};
  COLUMNS.forEach((c) => {
    const names = [c.key, c.title, ...c.alias].map(norm);
    const i = header.findIndex((h) => names.includes(h));
    if (i >= 0) idx[c.key] = i;
  });
  if (idx.DomainName === undefined || idx.Backends === undefined) {
    throw new Error('第一列標題必須包含「來源網域」與「後端主機」欄位（可下載範本參考）');
  }
  const body = table.slice(1);
  if (body.length > MAX_ROWS) throw new Error(`一次最多匯入 ${MAX_ROWS} 筆`);
  return body.map((r, n) => {
    const get = (k) => (idx[k] === undefined ? '' : String(r[idx[k]] ?? '').trim());
    const parseErrors = [];
    const row = {
      line: n + 2,
      DomainName: get('DomainName').toLowerCase(),
      Upstreams: parseBackends(get('Backends'), parseErrors),
      LbMethod: null,
      LbCookieName: get('LbCookieName') || null,
      Certificate: get('Certificate') || null,
      ClientMaxBodySize: get('ClientMaxBodySize') || null,
      Remark: get('Remark') || null,
    };
    const lb = norm(get('LbMethod'));
    if (lb) {
      row.LbMethod = LB_NAMES[lb] || null;
      if (!row.LbMethod) parseErrors.push(`「分配方式」只能是 輪流 / 最少連線 / 依Cookie固定（目前：${get('LbMethod')}）`);
    }
    BOOL_KEYS.forEach((k) => { row[k] = parseBool(get(k), parseErrors, COLUMNS.find((c) => c.key === k).title); });
    row.parseErrors = parseErrors;
    return row;
  });
}

const upKey = (u) => `${String(u.Host).toLowerCase()}:${Number(u.Port)}`;
const backendText = (ups) => (ups || []).map((u) => `${u.Host}:${u.Port}${Number(u.Weight) > 1 ? `*${u.Weight}` : ''}${u.IsBackup ? '(備援)' : ''}${u.IsActive === false ? '(停用)' : ''}`).join('; ');

/** 清理前端送回的列（確認匯入時），只取允許的欄位 */
function cleanClientRow(r, i) {
  const s = (v, max) => (v === null || v === undefined || v === '' ? null : String(v).trim().slice(0, max));
  const b = (v) => (v === null || v === undefined || v === '' ? null : v === true || v === 'true' || v === 1 || v === '1');
  return {
    line: Number(r?.line) || i + 1,
    DomainName: String(r?.DomainName || '').trim().toLowerCase(),
    Upstreams: Array.isArray(r?.Upstreams) ? r.Upstreams.slice(0, 64).map((u) => ({
      Host: String(u?.Host || '').trim(), Port: Number(u?.Port), Weight: Number(u?.Weight || 1), IsBackup: b(u?.IsBackup) === true, IsActive: b(u?.IsActive) !== false,
    })) : [],
    LbMethod: s(r?.LbMethod, 16), LbCookieName: s(r?.LbCookieName, 64), Certificate: s(r?.Certificate, 200),
    ClientMaxBodySize: s(r?.ClientMaxBodySize, 16), Remark: s(r?.Remark, 500),
    ForceHttps: b(r?.ForceHttps), EnableWebSocket: b(r?.EnableWebSocket), IsActive: b(r?.IsActive), IsMaintenance: b(r?.IsMaintenance),
    action: ['create', 'update', 'skip'].includes(r?.action) ? r.action : null,
    parseErrors: [],
  };
}

/**
 * 比對資料庫並驗證每一列
 * @param rows        列物件
 * @param existing    既有規則（含 Upstreams）
 * @param certs       憑證（不含 PEM）
 * 回傳每列加上：status（error / duplicate / exists / new）、errors、warnings、duplicateOf、existingId、action、merged（實際要寫入的資料）
 */
function analyze(rows, existing, certs) {
  const byDomain = new Map(existing.map((r) => [r.DomainName.toLowerCase(), r]));
  const firstLineOf = new Map(); // 檔案內網域第一次出現的列
  return rows.map((row) => {
    const errors = [...(row.parseErrors || [])];
    const warnings = [];
    const domain = row.DomainName;
    const ex = byDomain.get(domain) || null;
    const domainOk = DOMAIN_RE.test(domain);
    if (!domain) errors.push('「來源網域」必填');
    else if (!domainOk) errors.push(`來源網域「${domain}」格式不正確（例：portal.aeust.edu.tw）`);

    // 憑證：別名 / 編號，或自動挑選
    let cert = null;
    if (row.Certificate) {
      cert = certs.find((c) => String(c.Id) === row.Certificate || c.Alias.toLowerCase() === row.Certificate.toLowerCase()) || null;
      if (!cert) errors.push(`找不到 SSL 憑證「${row.Certificate}」`);
    } else if (ex) {
      cert = certs.find((c) => c.Id === ex.CertificateId) || null;
    } else if (domainOk) {
      cert = certs.filter((c) => certCoversDomain(c.SanDomains, domain))
        .sort((a, b) => new Date(b.ValidTo) - new Date(a.ValidTo))[0] || null;
      if (!cert) errors.push('憑證庫中沒有涵蓋此網域的憑證，請先上傳或在「SSL憑證」欄指定');
    }
    if (cert && domainOk && !certCoversDomain(cert.SanDomains, domain)) errors.push(`憑證「${cert.Alias}」不涵蓋 ${domain}`);
    if (cert && new Date(cert.ValidTo) < new Date()) warnings.push(`憑證「${cert.Alias}」已過期`);

    // 合併：空白欄位 → 既有值（覆蓋時）或預設值（新增時）
    const pickv = (k, def) => (row[k] !== null && row[k] !== undefined ? row[k] : ex ? ex[k] : def);
    const merged = {
      DomainName: domain,
      Upstreams: row.Upstreams,
      LbMethod: pickv('LbMethod', 'round_robin'),
      LbCookieName: null,
      CertificateId: cert ? cert.Id : null,
      ForceHttps: pickv('ForceHttps', true),
      EnableWebSocket: pickv('EnableWebSocket', false),
      ClientMaxBodySize: pickv('ClientMaxBodySize', '2M'),
      IsActive: pickv('IsActive', true),
      IsMaintenance: pickv('IsMaintenance', false),
      Remark: pickv('Remark', null),
    };
    merged.LbCookieName = merged.LbMethod === 'cookie' ? pickv('LbCookieName', null) : null;
    if (domainOk) {
      validateRule({ ...merged, CertificateId: merged.CertificateId || -1 })
        .filter((e) => !e.startsWith('來源網域') && !(row.parseErrors || []).length)
        .forEach((e) => { if (!errors.includes(e)) errors.push(e); });
    }

    // 重複判斷：相同網域 + 相同後端 IP:Port
    const keys = new Set(row.Upstreams.map(upKey));
    const sameBackend = (ups) => (ups || []).some((u) => keys.has(upKey(u)));
    let duplicateOf = null;
    const prev = firstLineOf.get(domain);
    if (domain && prev) {
      if (sameBackend(prev.Upstreams)) duplicateOf = { type: 'file', line: prev.line, text: `與檔案第 ${prev.line} 列重複（相同網域與後端）` };
      else errors.push(`網域與第 ${prev.line} 列相同但後端不同，請只保留一列`);
    } else if (domain) firstLineOf.set(domain, row);
    if (!duplicateOf && ex && sameBackend(ex.Upstreams)) {
      duplicateOf = { type: 'existing', id: ex.Id, text: `與既有規則 #${ex.Id} 重複（相同網域與後端 ${backendText(ex.Upstreams.filter((u) => keys.has(upKey(u))))}）` };
    }

    let status = 'new';
    if (errors.length) status = 'error';
    else if (duplicateOf) status = 'duplicate';
    else if (ex) status = 'exists';

    let action = row.action;
    if (status === 'new') action = 'create';
    else if (status === 'error') action = null;
    else if (duplicateOf?.type === 'file') action = 'skip';
    else if (!['update', 'skip'].includes(action)) action = status === 'duplicate' ? 'update' : 'skip';

    return {
      line: row.line,
      DomainName: domain,
      Upstreams: row.Upstreams,
      BackendsText: backendText(row.Upstreams),
      LbMethod: row.LbMethod, LbCookieName: row.LbCookieName, Certificate: row.Certificate,
      ForceHttps: row.ForceHttps, EnableWebSocket: row.EnableWebSocket, IsActive: row.IsActive, IsMaintenance: row.IsMaintenance,
      ClientMaxBodySize: row.ClientMaxBodySize, Remark: row.Remark,
      CertAlias: cert ? cert.Alias : null,
      LbText: LB_TEXT[merged.LbMethod] || merged.LbMethod,
      existingId: ex ? ex.Id : null,
      existingBackends: ex ? backendText(ex.Upstreams) : null,
      status, errors, warnings, duplicateOf, action, merged,
    };
  });
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const yn = (v) => (v ? '是' : '否');

/** 匯出既有規則為 CSV（UTF-8 BOM，Excel 可直接開啟） */
function toCsv(rules, certs) {
  const head = COLUMNS.map((c) => c.title);
  const lines = rules.map((r) => [
    r.DomainName, backendText(r.Upstreams), LB_TEXT[r.LbMethod] || r.LbMethod, r.LbCookieName || '',
    (certs.find((c) => c.Id === r.CertificateId) || {}).Alias || r.CertificateId,
    yn(r.ForceHttps), yn(r.EnableWebSocket), r.ClientMaxBodySize, yn(r.IsActive), yn(r.IsMaintenance), r.Remark || '',
  ]);
  return `﻿${[head, ...lines].map((l) => l.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

module.exports = { rowsFromCsv, cleanClientRow, analyze, toCsv, parseCsv, MAX_ROWS, COLUMNS };

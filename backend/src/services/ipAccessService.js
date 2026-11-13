'use strict';
/**
 * IP 存取控制（v1.0.16 起）
 *
 * 兩層：
 *  - 全域黑名單（IpAccessSettings.BlockList）：所有網域一律拒絕 → sites-managed/_ip_blocklist.conf（http 層 geo）
 *  - 各網域（DomainRules.IpAccessMode / IpAccessList）：off 不限制 / allow 只允許清單 / deny 拒絕清單
 *    → 該網域設定檔頂端的 geo 對照表
 *
 * 判斷都放在 server 層的 rewrite 階段（if + rewrite 到 internal 頁面），因此：
 *  - 比 WAF（location 的 rewrite 階段）與 proxy_pass 更早，被擋的請求不會進 WAF、也不會送到後端
 *  - 自訂語法新增的 location 也受保護；/f5-health-check 一律放行（避免 F5 誤判節點故障）
 *  - $remote_addr 已由 PROXY protocol（real_ip）還原為真實來源 IP
 *
 * 安全：寫進設定檔的只有正規化後的 IPv4 / IPv6 位址或 CIDR；備註只會成為 nginx 註解（已去除控制字元與換行）。
 */

const MODES = ['off', 'allow', 'deny'];
const MODE_LABEL = { off: '不限制', allow: '只允許清單', deny: '拒絕清單' };
const MAX_RULE_ENTRIES = 200;
const MAX_GLOBAL_ENTRIES = 2000;
const REMARK_MAX = 100;

const BLOCKLIST_CONF_NAME = '_ip_blocklist.conf';
const GLOBAL_VAR = '$npm_ip_blocked';
const DENIED_URI = '/__npm_ip_denied';
const ruleVar = (rule) => `$npm_ip_acl_r${Number(rule.Id) || 0}`;

/* ------------------------------------------------------------------ 位址正規化 */
function parseIpv4(s) {
  const p = s.split('.');
  if (p.length !== 4 || !p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255)) return null;
  return p.map(Number);
}

/** IPv6 → 8 個 16-bit 數字（支援 :: 與結尾嵌入 IPv4）；格式錯誤回 null */
function parseIpv6(s) {
  if (!/^[0-9a-f:.]+$/i.test(s) || s.length > 45) return null;
  let str = s.toLowerCase();
  const tail = [];
  if (str.includes('.')) {
    const i = str.lastIndexOf(':');
    const v4 = parseIpv4(str.slice(i + 1));
    if (!v4) return null;
    tail.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
    // 「::ffff:1.2.3.4」→ 前段「::ffff」；「::1.2.3.4」→ 前段「::」
    const pre = str.slice(0, i + 1);
    str = pre.endsWith('::') ? pre : pre.slice(0, -1);
  }
  const halves = str.split('::');
  if (halves.length > 2) return null;
  const toNums = (h) => (h === '' ? [] : h.split(':').map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN)));
  const head = toNums(halves[0]);
  const rest = halves.length === 2 ? toNums(halves[1]) : [];
  if ([...head, ...rest].some(Number.isNaN)) return null;
  const need = 8 - tail.length;
  let groups;
  if (halves.length === 2) {
    if (head.length + rest.length >= need) return null;
    groups = [...head, ...Array(need - head.length - rest.length).fill(0), ...rest];
  } else {
    if (head.length !== need) return null;
    groups = head;
  }
  return [...groups, ...tail];
}

const v4Text = (a) => a.join('.');
function v6Text(g) {
  // 最長連續 0 壓成 ::（RFC 5952）
  let best = -1; let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (g[i] !== 0) { i += 1; continue; }
    let j = i;
    while (j < 8 && g[j] === 0) j += 1;
    if (j - i > bestLen && j - i > 1) { best = i; bestLen = j - i; }
    i = j;
  }
  const hex = g.map((x) => x.toString(16));
  if (best < 0) return hex.join(':');
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`;
}

/** 把位址的主機位元清為 0（bits = 每組位元數） */
function maskGroups(groups, prefix, bits) {
  return groups.map((v, i) => {
    const start = i * bits;
    if (prefix >= start + bits) return v;
    if (prefix <= start) return 0;
    const keep = prefix - start;
    return v & ((((1 << keep) - 1) << (bits - keep)) & ((1 << bits) - 1));
  });
}

/**
 * 單筆位址 / 網段正規化：回傳 { value } 或 { error }
 * - 網段會改成網路位址（例 192.168.1.5/24 → 192.168.1.0/24），避免 nginx 警告
 * - 不接受 /0（等於全部位址）與 0.0.0.0、::
 */
function normalizeCidr(input) {
  const raw = String(input || '').trim();
  const m = raw.match(/^([^/]+)(?:\/(\d{1,3}))?$/);
  if (!m) return { error: `「${raw.slice(0, 50)}」不是 IP 或網段` };
  const [, addr, pfx] = m;
  const v4 = parseIpv4(addr);
  if (v4) {
    const prefix = pfx === undefined ? 32 : Number(pfx);
    if (prefix < 1 || prefix > 32) return { error: `「${raw}」的網段長度只能是 /1–/32` };
    if (v4.every((x) => x === 0)) return { error: `「${raw}」不是有效的位址` };
    const net = maskGroups(v4, prefix, 8);
    return { value: prefix === 32 ? v4Text(net) : `${v4Text(net)}/${prefix}`, family: 4 };
  }
  const v6 = parseIpv6(addr);
  if (v6) {
    const prefix = pfx === undefined ? 128 : Number(pfx);
    if (prefix < 1 || prefix > 128) return { error: `「${raw}」的網段長度只能是 /1–/128` };
    if (v6.every((x) => x === 0)) return { error: `「${raw}」不是有效的位址` };
    const net = maskGroups(v6, prefix, 16);
    return { value: prefix === 128 ? v6Text(net) : `${v6Text(net)}/${prefix}`, family: 6 };
  }
  return { error: `「${raw.slice(0, 50)}」不是 IP 或網段（例：120.96.1.10、120.96.0.0/16、2001:db8::/32）` };
}

const cleanRemark = (s) => String(s || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, REMARK_MAX);

/**
 * 解析清單文字：一行一筆（同一行也可用逗號 / 空白分隔多筆），「#」後為備註
 * @returns {{ entries: {cidr, remark}[], errs: string[] }}
 */
function parseList(text, { max = MAX_RULE_ENTRIES, label = 'IP 清單' } = {}) {
  const entries = [];
  const errs = [];
  const seen = new Set();
  String(text || '').split(/\r?\n/).forEach((line, idx) => {
    const hash = line.indexOf('#');
    const body = (hash >= 0 ? line.slice(0, hash) : line).trim();
    const remark = hash >= 0 ? cleanRemark(line.slice(hash + 1)) : '';
    if (!body) return;
    body.split(/[\s,，、;；]+/).filter(Boolean).forEach((tok) => {
      const r = normalizeCidr(tok);
      if (r.error) { errs.push(`${label}第 ${idx + 1} 行：${r.error}`); return; }
      if (seen.has(r.value)) return; // 重複的直接略過
      seen.add(r.value);
      entries.push({ cidr: r.value, remark });
    });
  });
  if (entries.length > max) errs.push(`${label}最多 ${max} 筆（目前 ${entries.length} 筆）`);
  return { entries, errs: errs.slice(0, 10) };
}

/** 存入資料庫前的正規化文字（每行「位址  # 備註」）；空清單回 null */
function formatList(entries) {
  if (!entries.length) return null;
  return entries.map((e) => (e.remark ? `${e.cidr}  # ${e.remark}` : e.cidr)).join('\n');
}
const normalizeListText = (text, opts) => formatList(parseList(text, opts).entries);

/** 網域規則欄位驗證（由 nginxTemplate.validateRule 呼叫） */
function validateRuleIp(r) {
  const mode = r.IpAccessMode || 'off';
  if (!MODES.includes(mode)) return ['IP 存取控制只能是 不限制 / 只允許清單 / 拒絕清單'];
  const { entries, errs } = parseList(r.IpAccessList, { label: 'IP 清單' });
  if (errs.length) return errs;
  if (mode !== 'off' && !entries.length) {
    return [mode === 'allow' ? '「只允許清單」至少要填一筆 IP 或網段，否則所有人都無法連線' : '「拒絕清單」至少要填一筆 IP 或網段'];
  }
  return [];
}

/* ------------------------------------------------------------------ 產生設定 */
// 備註只當 nginx 註解；再去掉可能干擾閱讀的符號（換行已在 cleanRemark 去除）
const commentSafe = (s) => String(s).replace(/[{};'"$\\`]/g, ' ').replace(/\s+/g, ' ').trim();
const geoLines = (varName, dflt, hit, entries) => [
  `geo $remote_addr ${varName} {`,
  `    default ${dflt};`,
  ...entries.map((e) => `    ${e.cidr} ${hit};${e.remark ? `  # ${commentSafe(e.remark)}` : ''}`),
  '}',
];

/** 全域黑名單設定檔（http 層）；entries 為空時不應產生 */
function renderBlocklistConf(entries) {
  return [
    '# =====================================================================',
    '# Managed by Nginx HA Proxy Manager — 請勿手動修改，下次部署會被覆寫',
    `# 全域 IP 黑名單（${entries.length} 筆）：所有網域一律回 403；/f5-health-check 不受影響`,
    '# =====================================================================',
    '',
    ...geoLines(GLOBAL_VAR, 0, 1, entries),
    '',
  ].join('\n');
}

/** 該網域實際要套用的清單（off 或清單為空時回 null） */
function ruleAcl(rule) {
  const mode = rule.IpAccessMode || 'off';
  if (mode === 'off') return null;
  const { entries } = parseList(rule.IpAccessList);
  return entries.length ? { mode, entries } : null;
}

/** 網域設定檔頂端（http 層）的 geo；1 = 拒絕 */
function ruleGeoLines(rule) {
  const acl = ruleAcl(rule);
  if (!acl) return [];
  return [
    `# IP 存取控制：${MODE_LABEL[acl.mode]}（${acl.entries.length} 筆）`,
    ...(acl.mode === 'allow'
      ? geoLines(ruleVar(rule), 1, 0, acl.entries)
      : geoLines(ruleVar(rule), 0, 1, acl.entries)),
    '',
  ];
}

/**
 * server 區塊內的判斷（已縮排 4 格）；沒有任何限制時回傳空陣列
 * @param {boolean} globalBlock 本次部署是否有全域黑名單
 */
function serverIpLines(rule, globalBlock) {
  const acl = ruleAcl(rule);
  if (!acl && !globalBlock) return [];
  const label = [globalBlock && '全域黑名單', acl && `${MODE_LABEL[acl.mode]} ${acl.entries.length} 筆`].filter(Boolean).join(' + ');
  return [
    `    # IP 存取控制：${label}（/f5-health-check 不受影響）`,
    '    set $npm_ip_deny 0;',
    ...(globalBlock ? [`    if (${GLOBAL_VAR}) { set $npm_ip_deny 1; }`] : []),
    ...(acl ? [`    if (${ruleVar(rule)}) { set $npm_ip_deny 1; }`] : []),
    '    if ($uri = /f5-health-check) { set $npm_ip_deny 0; }',
    `    if ($npm_ip_deny) { rewrite ^ ${DENIED_URI} last; }`,
  ];
}

module.exports = {
  MODES, MODE_LABEL, MAX_RULE_ENTRIES, MAX_GLOBAL_ENTRIES, BLOCKLIST_CONF_NAME, DENIED_URI,
  normalizeCidr, parseList, formatList, normalizeListText, validateRuleIp,
  renderBlocklistConf, ruleAcl, ruleGeoLines, serverIpLines,
};

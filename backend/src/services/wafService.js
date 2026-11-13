'use strict';
/**
 * WAF（ModSecurity v3 + OWASP CRS 3.3，Ubuntu 套件 libnginx-mod-http-modsecurity / modsecurity-crs）
 *
 * 架構：
 *  - http 層只載入一次規則：sites-managed/_waf.conf → modsecurity_rules_file sites-managed/_waf_main.rules
 *    （.rules 不符合 nginx.conf 的 *.conf include，不會被當成 nginx 設定讀取）
 *  - 每個網域的 server 區塊各自 `modsecurity on;` 並以 modsecurity_rules 設定 SecRuleEngine 與排除規則 ID
 *  - 總開關關閉、或沒有任何網域開啟 WAF 時，不產生任何 WAF 檔案（與未導入 WAF 前的設定完全相同）
 *
 * 安全：插入設定檔的值只來自白名單（模式三選一、數字），不開放自訂 ModSecurity 規則文字
 *       （SecRule 可透過 exec 等動作執行程式，絕不能讓使用者輸入規則）。
 * 稽核紀錄（audit log）關閉：會記下 POST 內容（含登入密碼）；事件改由 nginx error.log 的「ModSecurity:」行查看。
 */
const config = require('../config');

const WAF_MODES = ['off', 'detect', 'block'];
const WAF_MODE_LABEL = { off: '關閉', detect: '僅偵測', block: '阻擋' };
const MAX_EXCLUDES = 50;
const RULE_ID_RE = /^\d{6,7}$/; // CRS 規則 ID 為 6 位數（9xxxxx），保留 7 位數彈性

const WAF_CONF_NAME = '_waf.conf';
const WAF_RULES_NAME = '_waf_main.rules';

/** 節點上必須存在的檔案（由 sysadmin 以 apt 安裝；deployer 只需讀取） */
const NODE_PATHS = {
  module: '/usr/lib/nginx/modules/ngx_http_modsecurity_module.so',
  load: '/etc/nginx/modules-enabled/50-mod-http-modsecurity.conf',
  unicode: '/etc/nginx/unicode.mapping',
  crsRules: '/usr/share/modsecurity-crs/rules',
};

/** 健康檢查 / 部署前檢查共用：輸出一行 WAF:<模組 0|1>:<CRS 版本> */
const WAF_CHECK_CMD = `echo "WAF:$(test -e ${NODE_PATHS.module} && test -e ${NODE_PATHS.load} && test -e ${NODE_PATHS.unicode} && test -d ${NODE_PATHS.crsRules} && echo 1 || echo 0):$(dpkg-query -W -f='\${Version}' modsecurity-crs 2>/dev/null)"`;

function parseWafCheck(out) {
  const m = String(out || '').match(/^WAF:([01]):(\S*)\s*$/m);
  if (!m) return null;
  return { ready: m[1] === '1', crsVersion: m[2] || null };
}

/** 排除規則 ID：接受逗號 / 空白 / 換行分隔，回傳 { ids: string[], errs: string[] } */
function parseExcludeIds(v) {
  const parts = String(v || '').split(/[\s,，、]+/).filter(Boolean);
  const errs = [];
  const bad = parts.filter((p) => !RULE_ID_RE.test(p));
  if (bad.length) errs.push(`WAF 排除規則 ID 只能是 6–7 位數字：${bad.slice(0, 5).join('、')}`);
  const ids = [...new Set(parts.filter((p) => RULE_ID_RE.test(p)))].sort();
  if (ids.length > MAX_EXCLUDES) errs.push(`WAF 排除規則最多 ${MAX_EXCLUDES} 條`);
  return { ids, errs };
}

/** 存入資料庫前的正規化：'942100, 942200' → '942100,942200'；空白 → null */
function normalizeExcludeIds(v) {
  const { ids } = parseExcludeIds(v);
  return ids.length ? ids.join(',') : null;
}

/** 規則欄位驗證（由 nginxTemplate.validateRule 呼叫） */
function validateRuleWaf(r) {
  const errs = [];
  const mode = r.WafMode || 'off';
  if (!WAF_MODES.includes(mode)) errs.push('WAF 模式只能是 關閉 / 僅偵測 / 阻擋');
  errs.push(...parseExcludeIds(r.WafExcludeIds).errs);
  return errs;
}

/** 全域設定驗證；回傳錯誤陣列 */
function validateSettings(s) {
  const errs = [];
  const pl = Number(s.ParanoiaLevel);
  if (!Number.isInteger(pl) || pl < 1 || pl > 4) errs.push('嚴格程度只能是 1–4');
  const th = Number(s.InboundThreshold);
  if (!Number.isInteger(th) || th < 1 || th > 100) errs.push('阻擋門檻分數必須為 1–100 的整數');
  return errs;
}

/** 該規則在本次部署是否實際啟用 WAF（總開關開啟、規則不是關閉、不在維護模式） */
const ruleWafActive = (rule, settings) => !!settings?.Enabled && (rule.WafMode || 'off') !== 'off' && !rule.IsMaintenance;

/** http 層：載入主規則檔 */
function renderWafConf() {
  return [
    '# =====================================================================',
    '# Managed by Nginx HA Proxy Manager — 請勿手動修改，下次部署會被覆寫',
    '# WAF（ModSecurity v3 + OWASP CRS）：http 層載入一次規則，各網域在自己的 server 區塊開啟',
    '# =====================================================================',
    '',
    `modsecurity_rules_file ${config.ssh.confDir}/${WAF_RULES_NAME};`,
    '',
  ].join('\n');
}

/** ModSecurity 主規則檔：基本設定 + CRS 設定 + 載入 CRS 規則 */
function renderWafRules(settings) {
  const errs = validateSettings(settings);
  if (errs.length) throw new Error(`WAF 全域設定不正確：${errs.join('；')}`);
  const pl = Number(settings.ParanoiaLevel);
  const th = Number(settings.InboundThreshold);
  return [
    '# =====================================================================',
    '# Managed by Nginx HA Proxy Manager — 請勿手動修改，下次部署會被覆寫',
    `# WAF 全域設定：嚴格程度 ${pl}、阻擋門檻 ${th}`,
    '# =====================================================================',
    '',
    '# ---- 基本設定（引擎模式由各網域的 modsecurity_rules 決定）----',
    'SecRuleEngine DetectionOnly',
    'SecRequestBodyAccess On',
    'SecRequestBodyLimit 13107200',
    'SecRequestBodyNoFilesLimit 131072',
    '# 超過檢查上限的大型上傳只檢查前段，不拒絕（避免上傳功能被 WAF 擋掉）',
    'SecRequestBodyLimitAction ProcessPartial',
    'SecResponseBodyAccess Off',
    'SecArgumentSeparator &',
    'SecCookieFormat 0',
    `SecUnicodeMapFile ${NODE_PATHS.unicode} 20127`,
    'SecStatusEngine Off',
    '# 稽核紀錄關閉（會記錄 POST 內容與密碼）；命中規則會寫入 nginx error.log',
    'SecAuditEngine Off',
    '',
    '# ---- 請求內容解析（取自 ModSecurity 建議設定）----',
    'SecRule REQUEST_HEADERS:Content-Type "(?:application(?:/soap\\+|/)|text/)xml" "id:200000,phase:1,t:none,t:lowercase,pass,nolog,ctl:requestBodyProcessor=XML"',
    'SecRule REQUEST_HEADERS:Content-Type "application/json" "id:200001,phase:1,t:none,t:lowercase,pass,nolog,ctl:requestBodyProcessor=JSON"',
    'SecRule REQBODY_ERROR "!@eq 0" "id:200002,phase:2,t:none,log,deny,status:400,msg:\'Failed to parse request body.\',logdata:\'%{reqbody_error_msg}\',severity:2"',
    '',
    '# ---- OWASP CRS 設定（取代 /etc/modsecurity/crs/crs-setup.conf）----',
    'SecDefaultAction "phase:1,log,auditlog,pass"',
    'SecDefaultAction "phase:2,log,auditlog,pass"',
    `SecAction "id:900000,phase:1,nolog,pass,t:none,setvar:tx.paranoia_level=${pl}"`,
    `SecAction "id:900110,phase:1,nolog,pass,t:none,setvar:tx.inbound_anomaly_score_threshold=${th},setvar:tx.outbound_anomaly_score_threshold=4"`,
    'SecAction "id:900990,phase:1,nolog,pass,t:none,setvar:tx.crs_setup_version=338"',
    '',
    '# ---- 載入 OWASP CRS 規則（apt 套件 modsecurity-crs，唯讀）----',
    `Include ${NODE_PATHS.crsRules}/*.conf`,
    '',
  ].join('\n');
}

/**
 * 單一網域 server 區塊內的 WAF 指令（已縮排 4 格）；未啟用時回傳空陣列
 * modsecurity_rules 內容只含白名單值：SecRuleEngine On|DetectionOnly 與數字規則 ID
 */
function serverWafLines(rule, settings) {
  if (!ruleWafActive(rule, settings)) return [];
  const engine = rule.WafMode === 'block' ? 'On' : 'DetectionOnly';
  const { ids, errs } = parseExcludeIds(rule.WafExcludeIds);
  if (errs.length) throw new Error(errs.join('；'));
  const body = [`SecRuleEngine ${engine}`, ...(ids.length ? [`SecRuleRemoveById ${ids.join(' ')}`] : [])];
  return [
    `    # WAF：${WAF_MODE_LABEL[rule.WafMode]}${ids.length ? `，排除 ${ids.length} 條規則` : ''}`,
    '    modsecurity on;',
    `    modsecurity_rules '${body.join('\n        ')}';`,
  ];
}

module.exports = {
  WAF_MODES, WAF_MODE_LABEL, WAF_CONF_NAME, WAF_RULES_NAME, WAF_CHECK_CMD, NODE_PATHS,
  parseWafCheck, parseExcludeIds, normalizeExcludeIds, validateRuleWaf, validateSettings, ruleWafActive,
  renderWafConf, renderWafRules, serverWafLines,
};

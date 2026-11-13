'use strict';
/**
 * 讀取節點上的 Nginx Log（唯讀）。
 *
 * - 檔案只能是白名單中的 access.log / error.log / waf.log，或 waf-<網域>.log（網域須通過白名單格式），路徑不接受使用者輸入。
 * - 關鍵字以單引號包起來交給 grep -F（固定字串比對，不是正規表示式），並先過濾控制字元與長度，避免指令注入。
 * - deployer 預設讀不到 /var/log/nginx（www-data:adm 640），需在節點以 ACL 授權，見 README「檢視節點 Nginx Log」。
 */
const config = require('../config');
const { NodeSession } = require('./sshSession');
const { wafDomainLogName } = require('./wafService');

// waf：開啟 WAF 的網域另寫 info 等級的 waf.log（見 wafService），只顯示 ModSecurity 事件
const LOG_FILES = { access: 'access.log', error: 'error.log', waf: 'waf.log' };
const LOG_FILTER = { waf: 'ModSecurity' };
const LINE_CHOICES = [100, 200, 500, 1000, 2000];
const SEARCH_SCAN_LINES = 50000; // 有關鍵字時，從最後這麼多行中搜尋
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_LINE_CHARS = 2000;
const KEYWORD_MAX = 100;

/** 包成 shell 單引號字串（' → '\''） */
const shellQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

class LogError extends Error {
  constructor(status, message, hint) {
    super(message);
    this.status = status;
    this.hint = hint;
  }
}

function normalizeOptions({ type, lines, q, domain }) {
  if (!LOG_FILES[type]) throw new LogError(400, 'Log 類型只能是 access、error 或 waf');
  const n = Number(lines) || 200;
  const count = LINE_CHOICES.includes(n) ? n : 200;
  const keyword = String(q || '').trim();
  if (keyword.length > KEYWORD_MAX) throw new LogError(400, `關鍵字最多 ${KEYWORD_MAX} 個字`);
  if (/[\x00-\x1f\x7f]/.test(keyword)) throw new LogError(400, '關鍵字不可含控制字元或換行');
  // WAF 可指定網域，改讀 waf-<網域>.log；檔名由白名單格式產生，不直接使用輸入
  let fileName = LOG_FILES[type];
  const d = String(domain || '').trim();
  if (type === 'waf' && d) {
    try { fileName = wafDomainLogName(d); } catch (e) { throw new LogError(400, e.message); }
  }
  return { type, count, keyword, fileName, domain: type === 'waf' && d ? d.toLowerCase() : null };
}

const PERMISSION_HINT = [
  '節點的 deployer 帳號沒有讀取 Nginx Log 的權限，請以 sysadmin 登入該節點執行一次：',
  'sudo apt-get install -y acl',
  `sudo setfacl -m u:deployer:rx ${config.ssh.logDir}`,
  `sudo setfacl -d -m u:deployer:r ${config.ssh.logDir}`,
  `sudo setfacl -m u:deployer:r ${config.ssh.logDir}/*.log`,
].join('\n');

/**
 * @returns {{ file, lines: string[], count, keyword, scanned, fetchedAt }}
 */
async function readNodeLog(node, opts) {
  const { type, count, keyword, fileName, domain } = normalizeOptions(opts);
  const file = `${config.ssh.logDir}/${fileName}`;
  // 固定過濾（waf.log 只看 ModSecurity 事件，略過 info 等級的其他雜訊）+ 使用者關鍵字
  const filters = [LOG_FILTER[type], keyword].filter(Boolean).map((k) => `grep -F -i -- ${shellQuote(k)}`);
  const cmd = filters.length
    ? `tail -n ${SEARCH_SCAN_LINES} -- ${shellQuote(file)} | ${filters.join(' | ')} | tail -n ${count}`
    : `tail -n ${count} -- ${shellQuote(file)}`;

  const s = new NodeSession(node);
  try {
    await s.open({ sftp: false });
    // 先確認可讀，權限不足時給明確的處理方式（grep 找不到時 exit 1，不能用 exit code 判斷）
    const chk = await s.exec(`test -r ${shellQuote(file)} && echo OK || (test -e ${shellQuote(file)} && echo DENIED || echo MISSING)`, 10000);
    const state = chk.stdout.trim();
    // 不用 403：前端遇 401/403 會視為登入失效而登出
    if (state === 'DENIED') throw new LogError(409,`無法讀取 ${file}（權限不足）`, PERMISSION_HINT);
    if (state === 'MISSING') {
      if (domain) throw new LogError(404, `節點上還沒有 ${file}（${domain} 尚未開啟 WAF 並部署，或部署後還沒有任何 WAF 事件）`);
      throw new LogError(404, type === 'waf' ? `節點上還沒有 ${file}（尚未有網域開啟 WAF 並部署）` : `節點上找不到 ${file}`);
    }
    const r = await s.exec(cmd, 30000);
    if (r.stderr.trim()) throw new LogError(502, `讀取 Log 失敗：${r.stderr.trim().slice(0, 300)}`);
    const text = r.stdout.length > MAX_OUTPUT_BYTES ? r.stdout.slice(-MAX_OUTPUT_BYTES) : r.stdout;
    const lines = text.split('\n').filter((l) => l !== '').map((l) => (l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}…` : l));
    return { file, domain, lines, count, keyword, scanned: filters.length ? SEARCH_SCAN_LINES : count, fetchedAt: new Date().toISOString() };
  } catch (e) {
    if (e instanceof LogError) throw e;
    throw new LogError(502, `無法連線節點讀取 Log：${String(e.message || e).slice(0, 300)}`);
  } finally {
    await s.close();
  }
}

module.exports = { readNodeLog, LogError, LINE_CHOICES };

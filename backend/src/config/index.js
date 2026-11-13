'use strict';
require('dotenv').config();

const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes)$/i.test(v));

const XML_NAME = /^[A-Za-z_][\w.-]*(:[A-Za-z_][\w.-]*)?$/;
const xmlName = (v, d, key) => {
  const s = (v || d).trim();
  if (!XML_NAME.test(s)) throw new Error(`.env 設定 ${key} 不是合法的 XML 元素名稱：${s}`);
  return s;
};

function regex(v, d) {
  try { return new RegExp(v || d, 'i'); } catch (e) { throw new Error(`.env 設定 SOAP_SUCCESS_REGEX 不是合法的正規表示式：${e.message}`); }
}

// dotenv 不支援字面 \n，範本若寫成單行可用 \n 表示換行（純美觀，SOAP 不需要換行）
const template = (process.env.SOAP_REQUEST_TEMPLATE || '').replace(/\\n/g, '\n').trim();

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  // Express trust proxy：loopback（預設）/ false / 數字（信任幾層代理）/ IP 或網段清單
  trustProxy: (() => {
    const v = (process.env.TRUST_PROXY || 'loopback').trim();
    if (/^(true|false)$/i.test(v)) return /^true$/i.test(v);
    if (/^\d+$/.test(v)) return parseInt(v, 10);
    return v;
  })(),
  auth: {
    // 特權帳號（逗號分隔，不分大小寫）：與「帳號管理」中啟用的帳號合併為可登入名單，且都需通過 SOAP 驗證
    adminAccounts: (process.env.ADMIN_ACCOUNTS || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    jwtSecret: process.env.JWT_SECRET || '',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
    maxFailures: parseInt(process.env.LOGIN_MAX_FAILURES || '5', 10),
    lockMinutes: parseInt(process.env.LOGIN_LOCK_MINUTES || '15', 10),
  },
  soap: {
    url: process.env.SOAP_URL || '',
    version: process.env.SOAP_VERSION === '1.2' ? '1.2' : '1.1',
    action: process.env.SOAP_ACTION || '',
    namespace: process.env.SOAP_NAMESPACE || 'http://tempuri.org/',
    method: xmlName(process.env.SOAP_METHOD, 'Authenticate', 'SOAP_METHOD'),
    userField: xmlName(process.env.SOAP_USER_FIELD, 'username', 'SOAP_USER_FIELD'),
    passField: xmlName(process.env.SOAP_PASS_FIELD, 'password', 'SOAP_PASS_FIELD'),
    requestTemplate: template,
    successRegex: regex(process.env.SOAP_SUCCESS_REGEX, '>\\s*true\\s*<'),
    timeoutMs: parseInt(process.env.SOAP_TIMEOUT_MS || '10000', 10),
    rejectUnauthorized: bool(process.env.SOAP_TLS_VERIFY, true),
  },
  nginx: {
    // 只接受 modern / legacy，其他值一律視為設定錯誤，避免默默產生錯誤語法
    http2Syntax: (() => {
      const v = (process.env.NGINX_HTTP2_SYNTAX || 'modern').trim().toLowerCase();
      if (v !== 'modern' && v !== 'legacy') throw new Error(`.env 設定 NGINX_HTTP2_SYNTAX 只能是 modern 或 legacy：${v}`);
      return v;
    })(),
    // PROXY protocol（前方 F5 做 SNAT 時還原真實客戶端 IP）：PROXY_PROTOCOL_FROM 留空 = 停用
    // 啟用後每個 server 另外監聽 httpPort / httpsPort（帶 proxy_protocol），且只信任 from 清單送來的 PROXY 標頭
    proxyProtocol: (() => {
      const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(\/([0-9]|[12]\d|3[0-2]))?$/;
      const from = (process.env.PROXY_PROTOCOL_FROM || '').split(/[\s,]+/).filter(Boolean);
      from.forEach((ip) => {
        if (!IPV4.test(ip)) throw new Error(`.env 設定 PROXY_PROTOCOL_FROM 格式錯誤：${ip}（應為 IPv4 或 x.x.x.x/nn）`);
      });
      const port = (key, d) => {
        const p = Number(process.env[key] || d);
        if (!Number.isInteger(p) || p < 1 || p > 65535 || p === 80 || p === 443) {
          throw new Error(`.env 設定 ${key} 必須為 1–65535 且不可為 80 / 443：${process.env[key]}`);
        }
        return p;
      };
      const httpPort = port('PROXY_PROTOCOL_HTTP_PORT', 8080);
      const httpsPort = port('PROXY_PROTOCOL_HTTPS_PORT', 8443);
      if (httpPort === httpsPort) throw new Error('.env 設定 PROXY_PROTOCOL_HTTP_PORT 與 PROXY_PROTOCOL_HTTPS_PORT 不可相同');
      return { enabled: from.length > 0, from, httpPort, httpsPort };
    })(),
  },
  // 切換前檢查：DNS 準備改指的 F5 VIP（IPv4），留空 = 停用此功能
  cutover: (() => {
    const vip = (process.env.CUTOVER_VIP || '').trim();
    if (vip && !/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(vip)) {
      throw new Error(`.env 設定 CUTOVER_VIP 必須為 IPv4 位址：${vip}`);
    }
    return { enabled: !!vip, vip };
  })(),
  healthIntervalSec: parseInt(process.env.HEALTH_INTERVAL_SEC || '60', 10),
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '1433', 10),
    name: process.env.DB_NAME || 'NginxProxyManager',
    user: process.env.DB_USER || 'sa',
    password: process.env.DB_PASSWORD || '',
    encrypt: bool(process.env.DB_ENCRYPT, false),
    trustServerCertificate: bool(process.env.DB_TRUST_SERVER_CERT, true),
  },
  ssh: {
    keyPath: process.env.SSH_KEY_PATH || '',
    passphrase: process.env.SSH_KEY_PASSPHRASE || '',
    connectTimeoutMs: parseInt(process.env.SSH_CONNECT_TIMEOUT_MS || '10000', 10),
    confDir: (process.env.REMOTE_CONF_DIR || '/etc/nginx/sites-managed').replace(/\/+$/, ''),
    sslDir: (process.env.REMOTE_SSL_DIR || '/etc/nginx/ssl').replace(/\/+$/, ''),
    backupPath: process.env.REMOTE_BACKUP_PATH || '/tmp/nginx_backup.tar.gz',
    logDir: (process.env.REMOTE_LOG_DIR || '/var/log/nginx').replace(/\/+$/, ''),
    testCmd: process.env.NGINX_TEST_CMD || 'sudo /usr/sbin/nginx -t',
    reloadCmd: process.env.NGINX_RELOAD_CMD || 'sudo /usr/bin/systemctl reload nginx',
  },
};

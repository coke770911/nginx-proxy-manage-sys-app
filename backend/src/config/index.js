'use strict';
require('dotenv').config();

const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes)$/i.test(v));

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  apiToken: process.env.API_TOKEN || '',
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
    testCmd: process.env.NGINX_TEST_CMD || 'sudo /usr/sbin/nginx -t',
    reloadCmd: process.env.NGINX_RELOAD_CMD || 'sudo /usr/bin/systemctl reload nginx',
  },
};

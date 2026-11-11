'use strict';
/**
 * 單一 Nginx 節點的 SSH + SFTP 連線封裝
 *  - exec(cmd)  : 以 ssh2 執行遠端指令，回傳 { code, stdout, stderr }
 *  - sftp       : ssh2-sftp-client 實例（open({sftp:true}) 後可用）
 */
const fs = require('fs');
const { Client } = require('ssh2');
const SftpClient = require('ssh2-sftp-client');
const config = require('../config');

// 'SHA256:AbC...' (ssh-keygen 格式) → 'AbC...'
const normalizeFp = (fp) => String(fp || '').replace(/^SHA256:/i, '').replace(/=+$/, '').trim();
const hexToB64 = (hex) => Buffer.from(hex, 'hex').toString('base64').replace(/=+$/, '');

class NodeSession {
  constructor(node) {
    this.node = node;
    this.name = node.NodeName;
    this.ssh = null;
    this.sftp = null;
    this.backedUp = false; // 階段一備份成功後為 true（回滾條件）
  }

  _connectConfig() {
    const keyPath = this.node.SshKeyPath || config.ssh.keyPath;
    if (!keyPath) throw new Error('未設定 SSH 私鑰路徑（.env 的 SSH_KEY_PATH 或 ProxyNodes.SshKeyPath）');
    const cfg = {
      host: this.node.IpAddress,
      port: this.node.SshPort,
      username: this.node.SshUser,
      privateKey: fs.readFileSync(keyPath),
      readyTimeout: config.ssh.connectTimeoutMs,
      keepaliveInterval: 10000,
    };
    if (config.ssh.passphrase) cfg.passphrase = config.ssh.passphrase;
    const expected = normalizeFp(this.node.HostKeySha256);
    if (expected) {
      cfg.hostHash = 'sha256';
      cfg.hostVerifier = (hashHex) => hexToB64(hashHex) === expected; // 主機金鑰指紋不符 → 拒絕連線（防中間人）
    }
    return cfg;
  }

  async open({ sftp = true } = {}) {
    const cfg = this._connectConfig();
    await new Promise((resolve, reject) => {
      const c = new Client();
      this.ssh = c;
      c.once('ready', resolve);
      c.once('error', reject);
      c.connect(cfg);
    });
    this.ssh.on('error', () => {}); // 連線建立後的 socket 錯誤交由 exec/put 的失敗處理，避免 uncaught
    if (sftp) {
      this.sftp = new SftpClient(`sftp-${this.name}`);
      await this.sftp.connect(cfg);
    }
    return this;
  }

  exec(cmd, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      this.ssh.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          stream.destroy();
          reject(new Error(`指令逾時（>${timeoutMs / 1000}s）：${cmd}`));
        }, timeoutMs);
        stream.on('data', (d) => { stdout += d; });
        stream.stderr.on('data', (d) => { stderr += d; });
        stream.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
        return undefined;
      });
    });
  }

  async close() {
    try { if (this.sftp) await this.sftp.end(); } catch (_) { /* ignore */ }
    try { if (this.ssh) this.ssh.end(); } catch (_) { /* ignore */ }
  }
}

/**
 * 讀取遠端主機的 SSH 主機金鑰指紋（不需登入，只完成金鑰交換即中斷）
 * @returns {Promise<string>} 'SHA256:xxxx'（與 ssh-keygen -lf 相同格式）
 */
function fetchHostFingerprint(host, port = 22, timeoutMs = config.ssh.connectTimeoutMs) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let fp = '';
    const done = (err) => {
      clearTimeout(timer);
      conn.end();
      if (fp) resolve(`SHA256:${fp}`);
      else reject(err || new Error('無法取得主機金鑰'));
    };
    const timer = setTimeout(() => done(new Error('連線逾時')), timeoutMs + 1000);
    conn.on('error', (e) => done(fp ? null : e));
    conn.connect({
      host,
      port,
      username: 'fingerprint-probe',
      readyTimeout: timeoutMs,
      hostHash: 'sha256',
      hostVerifier: (hashHex) => {
        fp = hexToB64(hashHex);
        setImmediate(() => done());
        return false; // 拒絕繼續連線，不送出任何認證資料
      },
    });
  });
}

module.exports = { NodeSession, fetchHostFingerprint, normalizeFp };

'use strict';
/**
 * 憑證解析與 PFX 轉檔服務
 *  - parseBundle()        : 驗證憑證/私鑰、解析 SAN 與到期日、比對公私鑰、整理成 Fullchain + 無密碼 PKCS#8 私鑰
 *  - fromPemFiles()       : 模式 1，直接上傳 .crt(Fullchain) + .key
 *  - fromPfx()            : 模式 2，上傳 IIS 匯出的 .pfx + 密碼，呼叫 openssl pkcs12 拆解
 *  - certCoversDomain()   : 檢查憑證 SAN 是否涵蓋指定網域（支援單層萬用字元）
 */
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

class CertError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CertError';
    this.status = 400;
  }
}

const PEM_CERT_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const PEM_KEY_RE = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]+?-----END (?:[A-Z]+ )?PRIVATE KEY-----/;

/* ------------------------------------------------------------------ helpers */
const dnField = (dn, field) => {
  const m = String(dn || '').match(new RegExp(`(?:^|\\n)${field}=([^\\n]+)`));
  return m ? m[1].trim() : '';
};

function parseSan(x509) {
  const sans = String(x509.subjectAltName || '')
    .split(/,\s*/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith('DNS:'))
    .map((s) => s.slice(4).replace(/^"|"$/g, '').toLowerCase());
  if (sans.length) return sans;
  const cn = dnField(x509.subject, 'CN'); // 舊式憑證無 SAN 時退回 CN
  return cn ? [cn.toLowerCase()] : [];
}

function certCoversDomain(sanCsv, domain) {
  const d = String(domain).toLowerCase();
  return String(sanCsv)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((san) => {
      if (san === d) return true;
      if (san.startsWith('*.') && !d.startsWith('*.')) {
        const suffix = san.slice(1); // ".aeust.edu.tw"
        return d.endsWith(suffix) && !d.slice(0, -suffix.length).includes('.');
      }
      return false;
    });
}

function loadPrivateKey(keyPem) {
  try {
    return crypto.createPrivateKey(keyPem);
  } catch (e) {
    if (e.code === 'ERR_MISSING_PASSPHRASE' || /passphrase|encrypted|bad decrypt|interrupted or cancelled/i.test(e.message)) {
      throw new CertError('私鑰檔有加密密碼，請先移除密碼（openssl rsa -in enc.key -out plain.key）或改用 PFX 模式上傳。');
    }
    throw new CertError(`無法解析私鑰檔：${e.message}`);
  }
}

/** 以私鑰找出葉憑證，並依 issuer 關係排序成 leaf → intermediate → root */
function orderChain(x509s, privateKey) {
  const leaf = x509s.find((c) => c.checkPrivateKey(privateKey)); // 比對公鑰 (Modulus / EC point)
  if (!leaf) {
    throw new CertError('憑證與私鑰不匹配：私鑰的公鑰與上傳檔案中所有憑證的公鑰皆不相符，已阻擋入庫。');
  }
  const chain = [leaf];
  const rest = x509s.filter((c) => c !== leaf);
  let cur = leaf;
  for (;;) {
    const i = rest.findIndex((c) => cur.checkIssued(c) && c.fingerprint256 !== cur.fingerprint256);
    if (i < 0) break;
    cur = rest.splice(i, 1)[0];
    chain.push(cur);
  }
  return { leaf, chain, extra: rest };
}

/* ------------------------------------------------------------------ core */
function parseBundle(certText, keyText) {
  const pems = String(certText).match(PEM_CERT_RE) || [];
  if (!pems.length) throw new CertError('憑證檔中找不到 PEM 格式憑證（-----BEGIN CERTIFICATE-----）。若為 DER/.cer 二進位格式請先轉成 PEM。');

  let x509s;
  try {
    x509s = pems.map((p) => new crypto.X509Certificate(p));
  } catch (e) {
    throw new CertError(`憑證解析失敗：${e.message}`);
  }

  const keyMatch = String(keyText).match(PEM_KEY_RE);
  if (!keyMatch) throw new CertError('私鑰檔中找不到 PEM 格式私鑰（-----BEGIN ... PRIVATE KEY-----）。');
  const privateKey = loadPrivateKey(keyMatch[0]);

  const { leaf, chain, extra } = orderChain(x509s, privateKey);
  const validFrom = new Date(leaf.validFrom);
  const validTo = new Date(leaf.validTo);
  const now = new Date();
  if (validTo < now) throw new CertError(`憑證已於 ${validTo.toISOString()} 過期，不允許入庫。`);

  const warnings = [];
  if (validFrom > now) warnings.push(`憑證尚未生效（生效日 ${validFrom.toISOString()}）。`);
  const selfSigned = leaf.checkIssued(leaf);
  if (chain.length === 1 && !selfSigned) warnings.push('檔案僅含葉憑證、未包含中繼憑證（非 Fullchain），部分舊版瀏覽器/客戶端可能驗證失敗。');
  if (extra.length) warnings.push(`有 ${extra.length} 張憑證與葉憑證無關聯，已略過。`);

  const sans = parseSan(leaf);
  const cn = dnField(leaf.subject, 'CN');
  const issuerCn = dnField(leaf.issuer, 'CN');
  const issuerO = dnField(leaf.issuer, 'O');

  return {
    certPem: `${chain.map((c) => c.toString().trim()).join('\n')}\n`,
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    sanDomains: sans.join(','),
    subject: cn || leaf.subject.replace(/\n/g, ', '),
    issuer: [issuerCn, issuerO && `(${issuerO})`].filter(Boolean).join(' ') || leaf.issuer.replace(/\n/g, ', '),
    fingerprint: leaf.fingerprint256,
    validFrom,
    validTo,
    warnings,
  };
}

/* ------------------------------------------------------------------ mode 1: crt + key */
function fromPemFiles(certBuf, keyBuf) {
  if (!certBuf || !keyBuf) throw new CertError('請同時上傳憑證檔（.crt / .pem）與私鑰檔（.key）。');
  return parseBundle(certBuf.toString('utf8'), keyBuf.toString('utf8'));
}

/* ------------------------------------------------------------------ mode 2: pfx */
async function opensslPkcs12(pfxPath, password, extraArgs) {
  const base = ['pkcs12', '-in', pfxPath, '-passin', 'env:PFX_PASS', ...extraArgs];
  const env = { ...process.env, PFX_PASS: password || '' }; // 密碼走環境變數，不出現在 process 參數列
  const opts = { env, timeout: 20000, maxBuffer: 5 * 1024 * 1024 };
  try {
    return await execFileAsync('openssl', base, opts);
  } catch (e1) {
    if (e1.code === 'ENOENT') throw new CertError('控制層主機找不到 openssl 指令，請先安裝 OpenSSL。');
    // OpenSSL 3.x 讀取舊版 Windows 匯出的 PFX（RC2-40/3DES）需 -legacy
    try {
      return await execFileAsync('openssl', [...base, '-legacy'], opts);
    } catch (e2) {
      const text = `${e1.stderr || ''}\n${e2.stderr || ''}`;
      if (/mac verify|invalid password|wrong password|bad decrypt/i.test(text)) throw new CertError('PFX 密碼錯誤，或檔案已損毀。');
      if (/not enough data|wrong tag|asn1|unable to load|invalid|bad (?:object|length)/i.test(text)) throw new CertError('無法讀取 PFX：檔案格式不正確。');
      throw new CertError(`openssl 解析 PFX 失敗：${(e2.stderr || e1.stderr || e2.message).toString().trim().split('\n').pop()}`);
    }
  }
}

async function fromPfx(pfxBuf, password) {
  if (!pfxBuf) throw new CertError('請上傳 .pfx / .p12 檔案。');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pfx-'));
  const pfxPath = path.join(dir, 'in.pfx');
  try {
    await fs.writeFile(pfxPath, pfxBuf, { mode: 0o600 });
    const certOut = await opensslPkcs12(pfxPath, password, ['-nokeys']);
    const keyOut = await opensslPkcs12(pfxPath, password, ['-nocerts', '-nodes']);
    if (!PEM_KEY_RE.test(keyOut.stdout)) throw new CertError('PFX 中找不到私鑰。');
    // 輸出中的 Bag Attributes 等雜訊由 parseBundle 的 PEM 區塊擷取過濾
    return parseBundle(certOut.stdout, keyOut.stdout);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 統一入口：mode = 'pem' | 'pfx'；files 為 multer 的 req.files */
async function importFromUpload({ mode, files = {}, pfxPassword = '' }) {
  const first = (f) => (files[f] && files[f][0] ? files[f][0].buffer : null);
  if (mode === 'pfx') return fromPfx(first('pfx'), pfxPassword);
  if (mode === 'pem') return fromPemFiles(first('cert'), first('key'));
  throw new CertError("上傳模式 mode 必須為 'pem' 或 'pfx'。");
}

module.exports = { CertError, parseBundle, fromPemFiles, fromPfx, importFromUpload, certCoversDomain };
